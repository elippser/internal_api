import { AnalyticsEvent } from "../analytics/analytics.model";
import {
  getCompanyModel,
  getPropertyModel,
  type PmsCompany,
  type PmsProperty,
} from "./pmsModels";

interface ListInput {
  search?: string;
  plan?: string;
  status?: string;
  page: number;
  limit: number;
}

interface ActivityInput {
  companyId: string;
  limit: number;
}

interface CompanyWithActivity extends PmsCompany {
  lastActivityAt?: Date | null;
  lastEventName?: string | null;
}

export const hotelsService = {
  async list(opts: ListInput) {
    const Company = await getCompanyModel();

    const filter: Record<string, unknown> = {};
    if (opts.plan) filter.plan = opts.plan;
    if (opts.status) filter.status = opts.status;
    if (opts.search) {
      filter.$or = [
        { name: { $regex: opts.search, $options: "i" } },
        { email: { $regex: opts.search, $options: "i" } },
        { companyId: opts.search },
      ];
    }

    const skip = (opts.page - 1) * opts.limit;
    const [companies, total] = await Promise.all([
      Company.find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(opts.limit)
        .lean(),
      Company.countDocuments(filter),
    ]);

    // Enriquecer con ultimo evento de analytics por companyId
    const companyIds = companies.map((c) => c.companyId);
    const lastEvents =
      companyIds.length === 0
        ? []
        : await AnalyticsEvent.aggregate([
            { $match: { companyId: { $in: companyIds } } },
            { $sort: { serverTimestamp: -1 } },
            {
              $group: {
                _id: "$companyId",
                eventName: { $first: "$eventName" },
                serverTimestamp: { $first: "$serverTimestamp" },
              },
            },
          ]);
    const eventMap = new Map(
      lastEvents.map((e: any) => [e._id, e]),
    );

    const data: CompanyWithActivity[] = companies.map((c) => {
      const ev = eventMap.get(c.companyId);
      return {
        ...c,
        lastActivityAt: ev?.serverTimestamp ?? null,
        lastEventName: ev?.eventName ?? null,
      };
    });

    return {
      data,
      total,
      page: opts.page,
      limit: opts.limit,
    };
  },

  async getById(companyId: string) {
    const Company = await getCompanyModel();
    const company = (await Company.findOne({ companyId }).lean()) as
      | PmsCompany
      | null;
    if (!company) return null;

    const [propertyAgg, eventAgg] = await Promise.all([
      this._propertyStats(companyId),
      this._eventStats(companyId),
    ]);

    return {
      ...company,
      stats: {
        propertyCount: propertyAgg.count,
        totalUnits: propertyAgg.totalUnits,
        eventsLast30d: eventAgg.last30d,
        lastActivityAt: eventAgg.lastActivityAt,
        lastEventName: eventAgg.lastEventName,
      },
    };
  },

  async listProperties(companyId: string) {
    const Property = await getPropertyModel();
    const properties = (await Property.find({ companyId })
      .sort({ createdAt: -1 })
      .lean()) as PmsProperty[];
    return properties;
  },

  async listActivity(input: ActivityInput) {
    const events = await AnalyticsEvent.find({ companyId: input.companyId })
      .sort({ serverTimestamp: -1 })
      .limit(input.limit)
      .lean();
    return events.map((e) => ({
      eventName: e.eventName,
      category: e.category,
      source: e.source,
      propertyId: e.propertyId ?? null,
      userId: e.userId ?? null,
      userRole: e.userRole ?? null,
      payload: e.payload ?? {},
      serverTimestamp: e.serverTimestamp,
    }));
  },

  // ---- helpers privados ----

  async _propertyStats(companyId: string) {
    const Property = await getPropertyModel();
    const props = (await Property.find({ companyId })
      .select({ unitCount: 1 })
      .lean()) as Array<{ unitCount?: number }>;
    return {
      count: props.length,
      totalUnits: props.reduce((acc, p) => acc + (p.unitCount ?? 0), 0),
    };
  },

  async _eventStats(companyId: string) {
    const thirtyAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [last30d, last] = await Promise.all([
      AnalyticsEvent.countDocuments({
        companyId,
        serverTimestamp: { $gte: thirtyAgo },
      }),
      AnalyticsEvent.findOne({ companyId })
        .sort({ serverTimestamp: -1 })
        .select({ eventName: 1, serverTimestamp: 1 })
        .lean(),
    ]);
    return {
      last30d,
      lastActivityAt: last?.serverTimestamp ?? null,
      lastEventName: last?.eventName ?? null,
    };
  },
};

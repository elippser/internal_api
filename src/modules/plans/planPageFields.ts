/**
 * Los textos editables de la pantalla `/planes` del PMS.
 *
 * La pantalla la renderiza un componente de Next en pms-core
 * (`components/planComponents/PlanSelectionView`); lo que se edita acá es su
 * copia: el encabezado, el pie, los estados y las etiquetas que se repiten en
 * cada tarjeta. Los nombres, precios y productos NO son texto editable — salen
 * del plan.
 *
 * Contrato: el PMS pide el contenido junto con el catalogo y usa el valor
 * cargado cuando existe; si esta vacio cae a su propio diccionario. Por eso un
 * campo en blanco no es un error ni deja un hueco en pantalla: significa
 * "usa el texto por defecto".
 *
 * `defaults` es una copia de esos textos por defecto y sirve SOLO para que el
 * editor los muestre como placeholder (mismo patron que `appCatalog` ↔
 * `osAppsCatalog`: se duplica a proposito porque internal-laupser no importa
 * codigo del PMS). Si el diccionario del PMS cambia y esta copia no, lo unico
 * que se desincroniza es el gris del placeholder — nunca lo que ve el hotelero.
 */

export const PLAN_PAGE_LOCALES = ["es", "en", "fr", "de", "pt"] as const;
export type PlanPageLocale = (typeof PLAN_PAGE_LOCALES)[number];

export const PLAN_PAGE_LOCALE_LABELS: Record<PlanPageLocale, string> = {
  es: "Español",
  en: "English",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
};

export interface PlanPageFieldDef {
  key: string;
  label: string;
  /** Que es y donde se ve. Lo lee quien edita, no el hotelero. */
  help: string;
  group: string;
  multiline: boolean;
  /** Variables que se reemplazan al pintar. Si faltan, el texto queda literal. */
  vars: string[];
  /** Clave del diccionario del PMS de la que sale el default. */
  fallbackKey: string;
  defaults: Record<PlanPageLocale, string>;
}

export const PLAN_PAGE_GROUPS = [
  { key: "header", label: "Encabezado" },
  { key: "card", label: "Etiquetas de las tarjetas" },
  { key: "footer", label: "Pie y estados" },
] as const;

export const PLAN_PAGE_FIELDS: PlanPageFieldDef[] = [
  // ── Encabezado ───────────────────────────────────────────────────────────
  {
    key: "eyebrow",
    label: "Chip superior",
    help: "La píldora chica arriba del título.",
    group: "header",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.ultimo_paso",
    defaults: {
      es: "Último paso",
      en: "Last step",
      fr: "Dernière étape",
      de: "Letzter Schritt",
      pt: "Último passo",
    },
  },
  {
    key: "title",
    label: "Título",
    help: "El encabezado principal de la pantalla.",
    group: "header",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.titulo",
    defaults: {
      es: "Elegí el plan de tu alojamiento",
      en: "Choose your property's plan",
      fr: "Choisissez le forfait de votre établissement",
      de: "Wählen Sie den Tarif Ihrer Unterkunft",
      pt: "Escolha o plano da sua acomodação",
    },
  },
  {
    key: "subtitle",
    label: "Bajada",
    help: "El párrafo debajo del título.",
    group: "header",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.subtitulo",
    defaults: {
      es: "El plan es de la empresa y define qué productos de bookfer podés usar. Lo podés cambiar cuando quieras.",
      en: "The plan belongs to the company and defines which bookfer products you can use. You can change it whenever you want.",
      fr: "Le forfait appartient à l'entreprise et définit les produits bookfer auxquels vous avez accès. Vous pouvez en changer quand vous le souhaitez.",
      de: "Der Tarif gehört zum Unternehmen und legt fest, welche bookfer-Produkte Sie nutzen können. Sie können ihn jederzeit wechseln.",
      pt: "O plano é da empresa e define quais produtos do bookfer você pode usar. Você pode trocá-lo quando quiser.",
    },
  },
  {
    key: "expiredTitle",
    label: "Título · plan vencido",
    help: "Reemplaza al título cuando la cuenta llega por vencimiento del plan.",
    group: "header",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.titulo_vencido",
    defaults: {
      es: "Tu plan venció",
      en: "Your plan has expired",
      fr: "Votre forfait a expiré",
      de: "Ihr Tarif ist abgelaufen",
      pt: "Seu plano venceu",
    },
  },
  {
    key: "expiredSubtitle",
    label: "Bajada · plan vencido",
    help: "Reemplaza a la bajada cuando el plan venció.",
    group: "header",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.subtitulo_vencido",
    defaults: {
      es: "Elegí un plan para volver a entrar a tu escritorio.",
      en: "Choose a plan to get back into your workspace.",
      fr: "Choisissez un forfait pour revenir à votre espace de travail.",
      de: "Wählen Sie einen Tarif, um wieder auf Ihren Arbeitsbereich zuzugreifen.",
      pt: "Escolha um plano para voltar ao seu painel.",
    },
  },
  {
    key: "expiredNotice",
    label: "Aviso de vencimiento",
    help: "La caja ámbar sobre la grilla. {plan} es el nombre del plan vencido.",
    group: "header",
    multiline: true,
    vars: ["plan"],
    fallbackKey: "planSelection.aviso_vencido",
    defaults: {
      es: "El período del plan {plan} terminó. Elegí un plan para seguir trabajando.",
      en: "The {plan} plan period has ended. Choose a plan to keep working.",
      fr: "La période du forfait {plan} est terminée. Choisissez un forfait pour continuer à travailler.",
      de: "Der Zeitraum des Tarifs {plan} ist abgelaufen. Wählen Sie einen Tarif, um weiterzuarbeiten.",
      pt: "O período do plano {plan} terminou. Escolha um plano para continuar trabalhando.",
    },
  },

  // ── Etiquetas de las tarjetas ────────────────────────────────────────────
  {
    key: "recommended",
    label: "Cinta del destacado",
    help: "La cinta del plan marcado como destacado.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.recomendado",
    defaults: {
      es: "Recomendado",
      en: "Recommended",
      fr: "Recommandé",
      de: "Empfohlen",
      pt: "Recomendado",
    },
  },
  {
    key: "includes",
    label: "Encabezado de la lista",
    help: "El rótulo sobre la lista de productos de cada tarjeta.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.incluye",
    defaults: {
      es: "Incluye",
      en: "Includes",
      fr: "Comprend",
      de: "Enthält",
      pt: "Inclui",
    },
  },
  {
    key: "cta",
    label: "Botón de la tarjeta",
    help: "La acción principal de cada plan.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.elegir_plan",
    defaults: {
      es: "Elegir este plan",
      en: "Choose this plan",
      fr: "Choisir ce forfait",
      de: "Diesen Tarif wählen",
      pt: "Escolher este plano",
    },
  },
  {
    key: "ctaLoading",
    label: "Botón mientras activa",
    help: "Lo que dice el botón entre el clic y la entrada al PMS.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.activando",
    defaults: {
      es: "Activando...",
      en: "Activating...",
      fr: "Activation...",
      de: "Wird aktiviert...",
      pt: "Ativando...",
    },
  },
  {
    key: "free",
    label: "Precio de un plan gratuito",
    help: "Reemplaza al importe en los planes gratis.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.gratis",
    defaults: {
      es: "Gratis",
      en: "Free",
      fr: "Gratuit",
      de: "Kostenlos",
      pt: "Grátis",
    },
  },
  {
    key: "freeDuration",
    label: "Duración del plan gratuito",
    help: "Va al lado del precio. {n} son los días de vigencia.",
    group: "card",
    multiline: false,
    vars: ["n"],
    fallbackKey: "planSelection.por_n_dias",
    defaults: {
      es: "por {n} días",
      en: "for {n} days",
      fr: "pendant {n} jours",
      de: "für {n} Tage",
      pt: "por {n} dias",
    },
  },
  {
    key: "periodMonthly",
    label: "Período mensual",
    help: "Va al lado del importe en los planes por mes.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.por_mes",
    defaults: {
      es: "por mes",
      en: "per month",
      fr: "par mois",
      de: "pro Monat",
      pt: "por mês",
    },
  },
  {
    key: "periodYearly",
    label: "Período anual",
    help: "Va al lado del importe en los planes por año.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.por_ano",
    defaults: {
      es: "por año",
      en: "per year",
      fr: "par an",
      de: "pro Jahr",
      pt: "por ano",
    },
  },
  {
    key: "periodOnce",
    label: "Período · pago único",
    help: "Va al lado del importe en los planes de pago único.",
    group: "card",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.pago_unico",
    defaults: {
      es: "pago único",
      en: "one-time payment",
      fr: "paiement unique",
      de: "Einmalzahlung",
      pt: "pagamento único",
    },
  },
  {
    key: "trial",
    label: "Prueba gratis",
    help: "La línea verde bajo el precio. {n} son los días de prueba.",
    group: "card",
    multiline: false,
    vars: ["n"],
    fallbackKey: "planSelection.n_dias_de_prueba",
    defaults: {
      es: "{n} días de prueba gratis",
      en: "{n}-day free trial",
      fr: "{n} jours d'essai gratuit",
      de: "{n} Tage kostenlos testen",
      pt: "{n} dias de teste grátis",
    },
  },
  {
    key: "limitProperties",
    label: "Chip de propiedades",
    help: "Límite de propiedades del plan. {n} es el número.",
    group: "card",
    multiline: false,
    vars: ["n"],
    fallbackKey: "planSelection.hasta_n_propiedades",
    defaults: {
      es: "Hasta {n} propiedades",
      en: "Up to {n} properties",
      fr: "Jusqu'à {n} établissements",
      de: "Bis zu {n} Unterkünfte",
      pt: "Até {n} propriedades",
    },
  },
  {
    key: "limitUsers",
    label: "Chip de usuarios",
    help: "Límite de usuarios del plan. {n} es el número.",
    group: "card",
    multiline: false,
    vars: ["n"],
    fallbackKey: "planSelection.hasta_n_usuarios",
    defaults: {
      es: "Hasta {n} usuarios",
      en: "Up to {n} users",
      fr: "Jusqu'à {n} utilisateurs",
      de: "Bis zu {n} Benutzer",
      pt: "Até {n} usuários",
    },
  },

  // ── Pie y estados ────────────────────────────────────────────────────────
  {
    key: "footnote",
    label: "Pie de página",
    help: "La línea gris debajo de la grilla.",
    group: "footer",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.pie_de_pagina",
    defaults: {
      es: "Los productos que tu plan no incluye siguen visibles en el menú: te avisamos al abrirlos.",
      en: "Products your plan doesn't include stay visible in the menu: we'll let you know when you open them.",
      fr: "Les produits non inclus dans votre forfait restent visibles dans le menu : nous vous prévenons lorsque vous les ouvrez.",
      de: "Produkte, die Ihr Tarif nicht enthält, bleiben im Menü sichtbar: Wir weisen Sie beim Öffnen darauf hin.",
      pt: "Os produtos que seu plano não inclui continuam visíveis no menu: avisamos quando você abri-los.",
    },
  },
  {
    key: "emptyTitle",
    label: "Sin planes · título",
    help: "Cuando no hay ningún plan público activo para ofrecer.",
    group: "footer",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.sin_planes_titulo",
    defaults: {
      es: "No hay planes disponibles",
      en: "No plans available",
      fr: "Aucun forfait disponible",
      de: "Keine Tarife verfügbar",
      pt: "Não há planos disponíveis",
    },
  },
  {
    key: "emptyText",
    label: "Sin planes · texto",
    help: "El párrafo del estado vacío.",
    group: "footer",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.sin_planes_texto",
    defaults: {
      es: "No pudimos cargar el catálogo de planes. Probá de nuevo en unos segundos o escribinos.",
      en: "We couldn't load the plan catalog. Try again in a few seconds or get in touch.",
      fr: "Nous n'avons pas pu charger le catalogue des forfaits. Réessayez dans quelques secondes ou contactez-nous.",
      de: "Der Tarifkatalog konnte nicht geladen werden. Versuchen Sie es in ein paar Sekunden erneut oder kontaktieren Sie uns.",
      pt: "Não conseguimos carregar o catálogo de planos. Tente de novo em alguns segundos ou fale com a gente.",
    },
  },
  {
    key: "retry",
    label: "Botón de reintento",
    help: "El botón del estado vacío.",
    group: "footer",
    multiline: false,
    vars: [],
    fallbackKey: "planSelection.reintentar",
    defaults: {
      es: "Reintentar",
      en: "Try again",
      fr: "Réessayer",
      de: "Erneut versuchen",
      pt: "Tentar de novo",
    },
  },
  {
    key: "errorUnavailable",
    label: "Error · catálogo caído",
    help: "Cuando el back-office no responde y no hay planes que mostrar.",
    group: "footer",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.error_catalogo_no_disponible",
    defaults: {
      es: "No pudimos cargar los planes en este momento. Probá de nuevo en unos segundos.",
      en: "We couldn't load the plans right now. Try again in a few seconds.",
      fr: "Nous n'avons pas pu charger les forfaits pour le moment. Réessayez dans quelques secondes.",
      de: "Die Tarife konnten gerade nicht geladen werden. Versuchen Sie es in ein paar Sekunden erneut.",
      pt: "Não conseguimos carregar os planos agora. Tente de novo em alguns segundos.",
    },
  },
  {
    key: "errorGeneric",
    label: "Error · genérico",
    help: "Cualquier otro fallo al cargar la pantalla.",
    group: "footer",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.error_generico",
    defaults: {
      es: "Algo salió mal al cargar los planes.",
      en: "Something went wrong while loading the plans.",
      fr: "Une erreur s'est produite lors du chargement des forfaits.",
      de: "Beim Laden der Tarife ist etwas schiefgelaufen.",
      pt: "Algo deu errado ao carregar os planos.",
    },
  },
  {
    key: "errorSelect",
    label: "Error · al elegir",
    help: "Cuando falla el guardado del plan elegido.",
    group: "footer",
    multiline: true,
    vars: [],
    fallbackKey: "planSelection.error_al_elegir",
    defaults: {
      es: "No pudimos activar el plan. Probá de nuevo.",
      en: "We couldn't activate the plan. Please try again.",
      fr: "Nous n'avons pas pu activer le forfait. Réessayez.",
      de: "Der Tarif konnte nicht aktiviert werden. Bitte erneut versuchen.",
      pt: "Não conseguimos ativar o plano. Tente de novo.",
    },
  },
];

export const PLAN_PAGE_FIELD_KEYS = PLAN_PAGE_FIELDS.map((f) => f.key);

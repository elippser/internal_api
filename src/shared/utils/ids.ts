import { v4 as uuid } from "uuid";

export function makeId(prefix: string): string {
  return `${prefix}-${uuid()}`;
}

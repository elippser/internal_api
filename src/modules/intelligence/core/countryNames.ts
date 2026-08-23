// Nombre de país en inglés → ISO 3166-1 alpha-2, para providers que no
// devuelven código (Bandsintown, WHO DON). Cobertura pragmática: mercados
// turísticos + países que aparecen en alertas sanitarias. Sin match, el
// caller decide (normalmente omite el countryCode del scope).

const MAP: Record<string, string> = {
  argentina: "AR", bolivia: "BO", brazil: "BR", chile: "CL", colombia: "CO",
  ecuador: "EC", paraguay: "PY", peru: "PE", uruguay: "UY", venezuela: "VE",
  "venezuela (bolivarian republic of)": "VE", mexico: "MX", "méxico": "MX",
  guatemala: "GT", honduras: "HN", nicaragua: "NI", "costa rica": "CR",
  panama: "PA", "panamá": "PA", cuba: "CU", "dominican republic": "DO",
  haiti: "HT", jamaica: "JM", "united states": "US",
  "united states of america": "US", canada: "CA",
  spain: "ES", portugal: "PT", france: "FR", italy: "IT", germany: "DE",
  "united kingdom": "GB",
  "united kingdom of great britain and northern ireland": "GB",
  ireland: "IE", netherlands: "NL", "netherlands (kingdom of the)": "NL",
  belgium: "BE", austria: "AT", switzerland: "CH", greece: "GR", turkey: "TR",
  "türkiye": "TR", poland: "PL", czechia: "CZ", "czech republic": "CZ",
  hungary: "HU", croatia: "HR", denmark: "DK", sweden: "SE", norway: "NO",
  finland: "FI", iceland: "IS", romania: "RO", bulgaria: "BG",
  australia: "AU", "new zealand": "NZ", japan: "JP", china: "CN",
  india: "IN", indonesia: "ID", thailand: "TH", vietnam: "VN",
  "viet nam": "VN", philippines: "PH", malaysia: "MY", singapore: "SG",
  "republic of korea": "KR", "south korea": "KR",
  "saudi arabia": "SA", "united arab emirates": "AE", qatar: "QA",
  israel: "IL", egypt: "EG", morocco: "MA", "south africa": "ZA",
  kenya: "KE", nigeria: "NG", ethiopia: "ET", ghana: "GH", senegal: "SN",
  "united republic of tanzania": "TZ", tanzania: "TZ", uganda: "UG",
  rwanda: "RW", burundi: "BI", zambia: "ZM", zimbabwe: "ZW", malawi: "MW",
  mozambique: "MZ", angola: "AO", cameroon: "CM", chad: "TD", niger: "NE",
  mali: "ML", "burkina faso": "BF", guinea: "GN", liberia: "LR",
  "sierra leone": "SL", "côte d'ivoire": "CI", "ivory coast": "CI",
  "democratic republic of the congo": "CD",
  "the democratic republic of the congo": "CD", congo: "CG",
  "central african republic": "CF", sudan: "SD", "south sudan": "SS",
  somalia: "SO", madagascar: "MG", mauritania: "MR", gabon: "GA",
  "equatorial guinea": "GQ", benin: "BJ", togo: "TG", gambia: "GM",
  "guinea-bissau": "GW", eritrea: "ER", djibouti: "DJ", libya: "LY",
  tunisia: "TN", algeria: "DZ", iraq: "IQ", iran: "IR",
  "iran (islamic republic of)": "IR", afghanistan: "AF", pakistan: "PK",
  bangladesh: "BD", nepal: "NP", "sri lanka": "LK", myanmar: "MM",
  cambodia: "KH", "lao people's democratic republic": "LA", laos: "LA",
  mongolia: "MN", kazakhstan: "KZ", yemen: "YE", jordan: "JO",
  lebanon: "LB", "syrian arab republic": "SY", syria: "SY",
  "papua new guinea": "PG", fiji: "FJ",
};

export function countryNameToIso(name: string | null | undefined): string | null {
  if (!name) return null;
  return MAP[name.trim().toLowerCase()] ?? null;
}

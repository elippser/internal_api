// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
/**
 * ICAO 3-letter airline designator → carrier identity.
 * Reference data (ICAO Doc 8585), not a data feed. Covers the world's major
 * scheduled carriers plus full Latin American coverage; unknown codes fall
 * through to `null` and the raw callsign is shown instead of a guess.
 */

export interface Airline {
  name: string;
  iata?: string;
  country: string;
}

export const AIRLINES: Record<string, Airline> = {
  // ── Latin America ──
  // The LAN/TAM codes predate the 2016 merger; the carriers are LATAM today,
  // so both the current brand and the legacy designator are shown.
  LAN: { name: 'LATAM Airlines (LAN)', iata: 'LA', country: 'Chile' },
  TAM: { name: 'LATAM Brasil (TAM)', iata: 'JJ', country: 'Brazil' },
  LPE: { name: 'LATAM Perú', iata: 'LP', country: 'Peru' },
  LNE: { name: 'LATAM Airlines Ecuador', iata: 'XL', country: 'Ecuador' },
  ARE: { name: 'LATAM Airlines Colombia', iata: '4C', country: 'Colombia' },
  LXP: { name: 'LATAM Express (LAN Express)', iata: 'LU', country: 'Chile' },
  AVA: { name: 'Avianca', iata: 'AV', country: 'Colombia' },
  ARG: { name: 'Aerolineas Argentinas', iata: 'AR', country: 'Argentina' },
  AMX: { name: 'Aeroméxico', iata: 'AM', country: 'Mexico' },
  VOI: { name: 'Volaris', iata: 'Y4', country: 'Mexico' },
  CMP: { name: 'Copa Airlines', iata: 'CM', country: 'Panama' },
  GLO: { name: 'GOL Linhas Aéreas', iata: 'G3', country: 'Brazil' },
  AZU: { name: 'Azul Brazilian Airlines', iata: 'AD', country: 'Brazil' },
  SKU: { name: 'Sky Airline', iata: 'H2', country: 'Chile' },
  BOV: { name: 'Boliviana de Aviación', iata: 'OB', country: 'Bolivia' },
  TAI: { name: 'Avianca El Salvador (TACA)', iata: 'TA', country: 'El Salvador' },
  PUE: { name: 'Aeropuelche', country: 'Chile' },
  MAA: { name: 'MasAir Cargo', iata: 'M7', country: 'Mexico' },

  // ── Middle East ──
  UAE: { name: 'Emirates', iata: 'EK', country: 'United Arab Emirates' },
  ETD: { name: 'Etihad Airways', iata: 'EY', country: 'United Arab Emirates' },
  QTR: { name: 'Qatar Airways', iata: 'QR', country: 'Qatar' },
  ABY: { name: 'Air Arabia', iata: 'G9', country: 'United Arab Emirates' },
  FDB: { name: 'flydubai', iata: 'FZ', country: 'United Arab Emirates' },
  SVA: { name: 'Saudia', iata: 'SV', country: 'Saudi Arabia' },
  KAC: { name: 'Kuwait Airways', iata: 'KU', country: 'Kuwait' },
  ELY: { name: 'El Al', iata: 'LY', country: 'Israel' },
  MSR: { name: 'EgyptAir', iata: 'MS', country: 'Egypt' },
  RJA: { name: 'Royal Jordanian', iata: 'RJ', country: 'Jordan' },
  THY: { name: 'Turkish Airlines', iata: 'TK', country: 'Türkiye' },
  PGT: { name: 'Pegasus Airlines', iata: 'PC', country: 'Türkiye' },
  SXS: { name: 'SunExpress', iata: 'XQ', country: 'Türkiye' },

  // ── Europe ──
  DLH: { name: 'Lufthansa', iata: 'LH', country: 'Germany' },
  AFR: { name: 'Air France', iata: 'AF', country: 'France' },
  KLM: { name: 'KLM', iata: 'KL', country: 'Netherlands' },
  BAW: { name: 'British Airways', iata: 'BA', country: 'United Kingdom' },
  IBE: { name: 'Iberia', iata: 'IB', country: 'Spain' },
  VLG: { name: 'Vueling', iata: 'VY', country: 'Spain' },
  AEA: { name: 'Air Europa', iata: 'UX', country: 'Spain' },
  RYR: { name: 'Ryanair', iata: 'FR', country: 'Ireland' },
  EZY: { name: 'easyJet', iata: 'U2', country: 'United Kingdom' },
  WZZ: { name: 'Wizz Air', iata: 'W6', country: 'Hungary' },
  SWR: { name: 'SWISS', iata: 'LX', country: 'Switzerland' },
  AUA: { name: 'Austrian Airlines', iata: 'OS', country: 'Austria' },
  SAS: { name: 'SAS Scandinavian Airlines', iata: 'SK', country: 'Sweden' },
  FIN: { name: 'Finnair', iata: 'AY', country: 'Finland' },
  TAP: { name: 'TAP Air Portugal', iata: 'TP', country: 'Portugal' },
  ITY: { name: 'ITA Airways', iata: 'AZ', country: 'Italy' },
  AEE: { name: 'Aegean Airlines', iata: 'A3', country: 'Greece' },
  LOT: { name: 'LOT Polish Airlines', iata: 'LO', country: 'Poland' },
  CSA: { name: 'Czech Airlines', iata: 'OK', country: 'Czechia' },
  TRA: { name: 'Transavia', iata: 'HV', country: 'Netherlands' },
  EWG: { name: 'Eurowings', iata: 'EW', country: 'Germany' },
  CFG: { name: 'Condor', iata: 'DE', country: 'Germany' },
  NOZ: { name: 'Norwegian', iata: 'DY', country: 'Norway' },
  AFL: { name: 'Aeroflot', iata: 'SU', country: 'Russia' },
  SDM: { name: 'Rossiya', iata: 'FV', country: 'Russia' },
  AUI: { name: 'Ukraine International Airlines', iata: 'PS', country: 'Ukraine' },

  // ── North America ──
  AAL: { name: 'American Airlines', iata: 'AA', country: 'United States' },
  DAL: { name: 'Delta Air Lines', iata: 'DL', country: 'United States' },
  UAL: { name: 'United Airlines', iata: 'UA', country: 'United States' },
  SWA: { name: 'Southwest Airlines', iata: 'WN', country: 'United States' },
  JBU: { name: 'JetBlue Airways', iata: 'B6', country: 'United States' },
  ASA: { name: 'Alaska Airlines', iata: 'AS', country: 'United States' },
  NKS: { name: 'Spirit Airlines', iata: 'NK', country: 'United States' },
  FFT: { name: 'Frontier Airlines', iata: 'F9', country: 'United States' },
  SKW: { name: 'SkyWest Airlines', iata: 'OO', country: 'United States' },
  ENY: { name: 'Envoy Air', iata: 'MQ', country: 'United States' },
  RPA: { name: 'Republic Airways', iata: 'YX', country: 'United States' },
  EDV: { name: 'Endeavor Air', iata: '9E', country: 'United States' },
  HAL: { name: 'Hawaiian Airlines', iata: 'HA', country: 'United States' },
  ACA: { name: 'Air Canada', iata: 'AC', country: 'Canada' },
  WJA: { name: 'WestJet', iata: 'WS', country: 'Canada' },
  TSC: { name: 'Air Transat', iata: 'TS', country: 'Canada' },
  POE: { name: 'Porter Airlines', iata: 'PD', country: 'Canada' },

  // ── Asia-Pacific ──
  ANA: { name: 'All Nippon Airways', iata: 'NH', country: 'Japan' },
  JAL: { name: 'Japan Airlines', iata: 'JL', country: 'Japan' },
  CCA: { name: 'Air China', iata: 'CA', country: 'China' },
  CES: { name: 'China Eastern', iata: 'MU', country: 'China' },
  CSN: { name: 'China Southern', iata: 'CZ', country: 'China' },
  CPA: { name: 'Cathay Pacific', iata: 'CX', country: 'Hong Kong' },
  SIA: { name: 'Singapore Airlines', iata: 'SQ', country: 'Singapore' },
  KAL: { name: 'Korean Air', iata: 'KE', country: 'South Korea' },
  AAR: { name: 'Asiana Airlines', iata: 'OZ', country: 'South Korea' },
  THA: { name: 'Thai Airways', iata: 'TG', country: 'Thailand' },
  MAS: { name: 'Malaysia Airlines', iata: 'MH', country: 'Malaysia' },
  GIA: { name: 'Garuda Indonesia', iata: 'GA', country: 'Indonesia' },
  PAL: { name: 'Philippine Airlines', iata: 'PR', country: 'Philippines' },
  AIC: { name: 'Air India', iata: 'AI', country: 'India' },
  IGO: { name: 'IndiGo', iata: '6E', country: 'India' },
  VTI: { name: 'Vistara', iata: 'UK', country: 'India' },
  QFA: { name: 'Qantas', iata: 'QF', country: 'Australia' },
  JST: { name: 'Jetstar', iata: 'JQ', country: 'Australia' },
  ANZ: { name: 'Air New Zealand', iata: 'NZ', country: 'New Zealand' },
  EVA: { name: 'EVA Air', iata: 'BR', country: 'Taiwan' },
  CAL: { name: 'China Airlines', iata: 'CI', country: 'Taiwan' },
  VJC: { name: 'VietJet Air', iata: 'VJ', country: 'Vietnam' },
  HVN: { name: 'Vietnam Airlines', iata: 'VN', country: 'Vietnam' },

  // ── Africa ──
  ETH: { name: 'Ethiopian Airlines', iata: 'ET', country: 'Ethiopia' },
  SAA: { name: 'South African Airways', iata: 'SA', country: 'South Africa' },
  RAM: { name: 'Royal Air Maroc', iata: 'AT', country: 'Morocco' },
  KQA: { name: 'Kenya Airways', iata: 'KQ', country: 'Kenya' },

  // ── Cargo ──
  FDX: { name: 'FedEx Express', iata: 'FX', country: 'United States' },
  UPS: { name: 'UPS Airlines (United Parcel Service)', iata: '5X', country: 'United States' },
  GTI: { name: 'Atlas Air', iata: '5Y', country: 'United States' },
  CLX: { name: 'Cargolux', iata: 'CV', country: 'Luxembourg' },
  ABW: { name: 'AirBridgeCargo', iata: 'RU', country: 'Russia' },
  CKS: { name: 'Kalitta Air', iata: 'K4', country: 'United States' },
};

/** Resolve an ICAO callsign prefix to a carrier. Returns null when unknown. */
export function airlineFor(code?: string | null): Airline | null {
  if (!code) return null;
  return AIRLINES[code.toUpperCase()] || null;
}

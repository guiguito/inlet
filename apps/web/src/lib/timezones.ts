/**
 * AN-002: zones whose IANA name changed, new name to former name, checked against the IANA
 * `backward` file (the "Alternate names" section and Pacific/Enderbury's link). A browser
 * with newer timezone data proposes the new name; a server whose data predates the change
 * lists only the former one, so the form offers that instead.
 */
const FORMER_NAMES: Record<string, string> = {
  'Africa/Asmara': 'Africa/Asmera',
  'America/Nuuk': 'America/Godthab',
  'Asia/Ashgabat': 'Asia/Ashkhabad',
  'Asia/Dhaka': 'Asia/Dacca',
  'Asia/Ho_Chi_Minh': 'Asia/Saigon',
  'Asia/Kathmandu': 'Asia/Katmandu',
  'Asia/Kolkata': 'Asia/Calcutta',
  'Asia/Macau': 'Asia/Macao',
  'Asia/Makassar': 'Asia/Ujung_Pandang',
  'Asia/Thimphu': 'Asia/Thimbu',
  'Asia/Ulaanbaatar': 'Asia/Ulan_Bator',
  'Asia/Yangon': 'Asia/Rangoon',
  'Atlantic/Faroe': 'Atlantic/Faeroe',
  'Europe/Kyiv': 'Europe/Kiev',
  'Pacific/Chuuk': 'Pacific/Truk',
  'Pacific/Kanton': 'Pacific/Enderbury',
  'Pacific/Pohnpei': 'Pacific/Ponape',
};

export function formerTimezoneName(timezone: string): string | undefined {
  return FORMER_NAMES[timezone];
}

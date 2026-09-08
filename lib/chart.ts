/**
 * Orquestador: junta las 3 capas. Este es "el patrón" completo de punta a punta.
 */
import { eclipticPositionOf, armcDeg, trueObliquityDeg, allPlanets, PlanetKey } from './ephemeris';
import { resolveLocalBirthTime } from './timezone';
import { computeHouses, HouseCusps } from './houses';

export interface BirthInput {
  year: number; month: number; day: number;
  hour?: number; minute?: number; // undefined/null => hora desconocida
  latitude: number; longitude: number;
  houseSystem?: 'whole-sign' | 'equal' | 'porphyry';
}

export interface NatalChart {
  utc: Date | null;
  planets: Record<PlanetKey, { longitude: number; latitude: number }>;
  houses: HouseCusps;
  timezoneSource: 'tzdata' | 'lmt-fallback' | 'n/a-unknown-time';
}

export function computeNatalChart(input: BirthInput): NatalChart {
  const hasTime = input.hour != null && input.minute != null;

  if (!hasTime) {
    // Sin hora: solo podemos ubicar los planetas en la fecha (a mediodía UTC como
    // referencia neutra: los planetas lentos no se mueven lo suficiente en un día
    // como para cambiar de signo salvo casos límite, que hay que avisar en la UI).
    const noonUtc = new Date(Date.UTC(input.year, input.month - 1, input.day, 12, 0, 0));
    const planets = allPlanets(noonUtc);
    const houses = computeHouses({ hasReliableBirthTime: false, sunLongitudeDeg: planets.Sun.longitude });
    return { utc: null, planets, houses, timezoneSource: 'n/a-unknown-time' };
  }

  const resolved = resolveLocalBirthTime({
    year: input.year, month: input.month, day: input.day,
    hour: input.hour!, minute: input.minute!,
    latitude: input.latitude, longitude: input.longitude,
  });

  const planets = allPlanets(resolved.utc);
  const eps = trueObliquityDeg(resolved.utc);
  const armc = armcDeg(resolved.utc, input.longitude);

  const houses = computeHouses({
    hasReliableBirthTime: true,
    sunLongitudeDeg: planets.Sun.longitude,
    armcDeg: armc,
    obliquityDeg: eps,
    latitudeDeg: input.latitude,
    preferredSystem: input.houseSystem ?? 'whole-sign',
  });

  return { utc: resolved.utc, planets, houses, timezoneSource: resolved.source };
}


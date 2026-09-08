/**
 * Capa 1: EPHEMERIS
 * -----------------
 * Envuelve `astronomy-engine` (Don Cross, VSOP87/ELP2000, MIT license) para producir
 * exactamente lo que un motor astrológico necesita: longitud eclíptica geocéntrica
 * aparente "of date" (la que se usa para signo/grado zodiacal tropical), más los dos
 * números que alimentan la capa de casas: oblicuidad verdadera (ε) y ARMC.
 *
 * OJO: astro.com NO usa esta librería. Astrodienst (los dueños de astro.com) escribieron
 * y publican su propio motor, Swiss Ephemeris (en C, basado en las efemérides JPL DE431/441
 * con un ajuste de alta precisión), que es lo que corre detrás de ese CGI. `astronomy-engine`
 * es un proyecto independiente de Don Cross: usa VSOP87/ELP2000 en vez de JPL, con una
 * precisión de ~1 arcosegundo/1 arcominuto en el rango 1700-2200 — más que suficiente para
 * un 99.9% de cartas natales, pero no bit-a-bit idéntico a Swiss Ephemeris. Si en algún
 * momento necesitas paridad exacta con astro.com, la única forma real es enlazar la propia
 * Swiss Ephemeris (paquetes npm `sweph` o `swisseph`), no esta librería. Ver ARCHITECTURE.md.
 */

import * as Astronomy from 'astronomy-engine';

export type PlanetKey =
  | 'Sun' | 'Moon' | 'Mercury' | 'Venus' | 'Mars'
  | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune' | 'Pluto';

export interface EclipticPosition {
  /** Longitud eclíptica geocéntrica aparente, grados [0,360) — esto define signo+grado. */
  longitude: number;
  /** Latitud eclíptica geocéntrica, grados. */
  latitude: number;
  /** Distancia geocéntrica en UA (útil para velocidad/retrogradación). */
  distanceAU: number;
}

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * Longitud eclíptica geocéntrica aparente de un cuerpo en un instante UTC dado.
 * Para el Sol usamos `SunPosition` (dedicada, más directa); para el resto,
 * GeoVector (aberración incluida, como es estándar en astrología) + Ecliptic().
 * Para la Luna usamos `EclipticGeoMoon`, que tiene su propia teoría lunar dedicada.
 */
export function eclipticPositionOf(body: PlanetKey, utcDate: Date): EclipticPosition {
  if (body === 'Sun') {
    const s = Astronomy.SunPosition(utcDate);
    return { longitude: norm360(s.elon), latitude: s.elat, distanceAU: s.vec.Length() };
  }
  if (body === 'Moon') {
    const m = Astronomy.EclipticGeoMoon(utcDate);
    return { longitude: norm360(m.lon), latitude: m.lat, distanceAU: m.dist };
  }
  const vec = Astronomy.GeoVector(Astronomy.Body[body], utcDate, true /* aberración */);
  const ecl = Astronomy.Ecliptic(vec);
  return { longitude: norm360(ecl.elon), latitude: ecl.elat, distanceAU: vec.Length() };
}

export function allPlanets(utcDate: Date): Record<PlanetKey, EclipticPosition> {
  const bodies: PlanetKey[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
  const out = {} as Record<PlanetKey, EclipticPosition>;
  for (const b of bodies) out[b] = eclipticPositionOf(b, utcDate);
  return out;
}

/**
 * Oblicuidad verdadera de la eclíptica (de fecha, con nutación), en grados.
 * `e_tilt` no está documentada en el README pero SÍ está exportada y tipada
 * en astronomy.d.ts — es la forma correcta de obtenerla sin recalcular IAU2006 a mano.
 */
export function trueObliquityDeg(utcDate: Date): number {
  const time = Astronomy.MakeTime(utcDate);
  const tilt = (Astronomy as any).e_tilt(time);
  return tilt.tobl;
}

/**
 * ARMC = Right Ascension of the Meridian, en grados = Tiempo Sidéreo Local × 15.
 * `SiderealTime()` da el GAST (Greenwich Apparent Sidereal Time) en horas sidéreas;
 * sumamos la longitud geográfica (Este positivo) convertida a horas.
 */
export function armcDeg(utcDate: Date, geoLongitudeDeg: number): number {
  const time = Astronomy.MakeTime(utcDate);
  const gastHours = Astronomy.SiderealTime(time);
  const lstHours = norm360(gastHours * 15 + geoLongitudeDeg) / 15;
  return norm360(lstHours * 15);
}

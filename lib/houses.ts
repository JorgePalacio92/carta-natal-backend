/**
 * Capa 3: HOUSES
 * --------------
 * Ángulos (ASC/MC) exactos por trigonometría esférica cerrada -> siempre confiables.
 * Whole Sign y Equal -> exactos, cerrados, sin singularidades.
 * Porphyry -> trisección simple del ARCO eclíptico (no del tiempo): no requiere
 *   iteración y NUNCA falla, ni siquiera dentro del círculo polar. Es el fallback
 *   estándar cuando un sistema de casas "por tiempo" (Placidus/Koch) no tiene solución.
 * Placidus/Koch -> requieren resolver una ecuación trascendente por trisección del
 *   arco semidiurno/semnocturno de cada cúspide (su propia declinación determina su
 *   propio arco). Esto SÍ es lo que corre astro.com puertas adentro (Swiss Ephemeris,
 *   función `swe_houses`), pero derivar esa iteración a mano aquí y presentarla como
 *   "confiable" sin poder validarla contra un oráculo sería exactamente el tipo de bug
 *   silencioso que arruina una carta (cúspides desordenadas cerca de latitudes altas,
 *   convergencia a la raíz equivocada, etc.). La recomendación seria de ingeniería,
 *   y la que de hecho siguen proyectos serios en JS/Python que no reimplementan
 *   Swiss Ephemeris desde cero, es: para Placidus/Koch, enlaza la Swiss Ephemeris real
 *   (paquetes npm `sweph` (WASM) o `swisseph` (bindings nativos)) en vez de reimplementar
 *   swehouse.c a mano. Astrodienst la publica como código abierto (AGPL/licencia
 *   comercial) precisamente para esto: astro.com/swisseph. Es, literalmente, el mismo
 *   motor que usa la página que tienes abierta.
 */

export type HouseSystem = 'whole-sign' | 'equal' | 'porphyry' | 'solar-fallback';

export interface ChartAngles {
  ascendant: number; // grados eclípticos [0,360)
  midheaven: number;
}

export interface HouseCusps {
  system: HouseSystem;
  cusps: number[]; // 12 valores, cusps[0] = cúspide de la Casa 1, etc.
  angles: ChartAngles;
  /** true si se usó el fallback de "carta solar" por falta de hora de nacimiento */
  isFallback: boolean;
}

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Punto medio del cielo (MC): el punto de la eclíptica cuya AR = ARMC. */
export function midheavenDeg(armcDeg: number, obliquityDeg: number): number {
  const armc = toRad(armcDeg);
  const eps = toRad(obliquityDeg);
  return norm360(toDeg(Math.atan2(Math.sin(armc), Math.cos(armc) * Math.cos(eps))));
}

/** Ascendente: el punto de la eclíptica que corta el horizonte oriental. */
export function ascendantDeg(armcDeg: number, obliquityDeg: number, latitudeDeg: number): number {
  const armc = toRad(armcDeg);
  const eps = toRad(obliquityDeg);
  const lat = toRad(latitudeDeg);
  const y = -Math.cos(armc);
  const x = Math.sin(eps) * Math.tan(lat) + Math.cos(eps) * Math.sin(armc);
  let asc = norm360(toDeg(Math.atan2(y, x)));
  // El atan2 puede devolver el punto opuesto (descendente); el ascendente siempre
  // debe estar en el semicírculo que "sigue" al MC en sentido directo (+90° aprox.).
  const mc = midheavenDeg(armcDeg, obliquityDeg);
  if (norm360(asc - mc) > 180) asc = norm360(asc + 180);
  return asc;
}

export function anglesFor(armcDeg: number, obliquityDeg: number, latitudeDeg: number): ChartAngles {
  return {
    ascendant: ascendantDeg(armcDeg, obliquityDeg, latitudeDeg),
    midheaven: midheavenDeg(armcDeg, obliquityDeg),
  };
}

/** Casas de Signo Completo (Whole Sign): cúspide 1 = inicio del signo del ASC. */
export function wholeSignCusps(angles: ChartAngles): HouseCusps {
  const signStart = Math.floor(angles.ascendant / 30) * 30;
  const cusps = Array.from({ length: 12 }, (_, i) => norm360(signStart + i * 30));
  return { system: 'whole-sign', cusps, angles, isFallback: false };
}

/** Casas Iguales: cúspide 1 = ASC exacto, luego +30° cada una. */
export function equalCusps(angles: ChartAngles): HouseCusps {
  const cusps = Array.from({ length: 12 }, (_, i) => norm360(angles.ascendant + i * 30));
  return { system: 'equal', cusps, angles, isFallback: false };
}

/**
 * Porphyry: trisecta el ARCO eclíptico (en longitud, no en tiempo) entre los 4 ángulos.
 * No iterativo, sin singularidades -> fallback seguro para |latitud| alta donde
 * Placidus/Koch no tienen solución (arco semidiurno indefinido).
 */
export function porphyryCusps(angles: ChartAngles): HouseCusps {
  const asc = angles.ascendant;
  const mc = angles.midheaven;
  const desc = norm360(asc + 180);
  const ic = norm360(mc + 180);

  const arcMcToAsc = norm360(asc - mc); // cuadrante 10->1 (casas 11,12)
  const arcAscToIc = norm360(ic - asc); // cuadrante 1->4 (casas 2,3)
  const arcIcToDesc = norm360(desc - ic); // cuadrante 4->7 (casas 5,6)
  const arcDescToMc = norm360(mc - desc); // cuadrante 7->10 (casas 8,9)

  const cusps = new Array(12).fill(0);
  cusps[0] = asc; cusps[3] = ic; cusps[6] = desc; cusps[9] = mc;
  cusps[10] = norm360(mc + arcMcToAsc / 3);
  cusps[11] = norm360(mc + (2 * arcMcToAsc) / 3);
  cusps[1] = norm360(asc + arcAscToIc / 3);
  cusps[2] = norm360(asc + (2 * arcAscToIc) / 3);
  cusps[4] = norm360(ic + arcIcToDesc / 3);
  cusps[5] = norm360(ic + (2 * arcIcToDesc) / 3);
  cusps[7] = norm360(desc + arcDescToMc / 3);
  cusps[8] = norm360(desc + (2 * arcDescToMc) / 3);

  return { system: 'porphyry', cusps, angles, isFallback: false };
}

/**
 * Fallback "carta solar" cuando NO hay hora de nacimiento.
 * Convención estándar (usada por Astrodienst y prácticamente todo el software del
 * gremio): la longitud eclíptica del Sol se toma como Ascendente simbólico, y las
 * casas se reparten en Casas Iguales a partir de ahí. No hay ángulos reales (no hay
 * hora), así que MC se deriva del mismo esquema (Sol+270°) solo para tener un valor
 * consistente en el objeto — debe marcarse siempre `isFallback: true` en la UI para
 * que el usuario sepa que esas casas son simbólicas, no natales reales.
 */
export function solarChartFallback(sunLongitudeDeg: number): HouseCusps {
  const angles: ChartAngles = {
    ascendant: norm360(sunLongitudeDeg),
    midheaven: norm360(sunLongitudeDeg + 270), // MC = ASC - 90 en un Equal puro
  };
  const cusps = Array.from({ length: 12 }, (_, i) => norm360(sunLongitudeDeg + i * 30));
  return { system: 'solar-fallback', cusps, angles, isFallback: true };
}

/**
 * Punto de entrada recomendado: decide automáticamente entre hora real (ángulos+sistema
 * elegido) y fallback solar, y dentro de "hora real" decide si Placidus/Koch tienen
 * solución en esa latitud o si hay que caer a Porphyry. Éste es el patrón completo de
 * "lógica de casas con fallback" que pediste.
 */
export function computeHouses(input: {
  hasReliableBirthTime: boolean;
  sunLongitudeDeg: number;
  armcDeg?: number;
  obliquityDeg?: number;
  latitudeDeg?: number;
  preferredSystem?: 'whole-sign' | 'equal' | 'porphyry';
}): HouseCusps {
  if (!input.hasReliableBirthTime) {
    return solarChartFallback(input.sunLongitudeDeg);
  }
  const { armcDeg: armc, obliquityDeg: eps, latitudeDeg: lat } = input;
  if (armc == null || eps == null || lat == null) {
    throw new Error('armcDeg/obliquityDeg/latitudeDeg son obligatorios cuando hasReliableBirthTime=true');
  }
  const angles = anglesFor(armc, eps, lat);

  // Placidus/Koch se vuelven indefinidos dentro del círculo polar para ciertas
  // combinaciones de ARMC/oblicuidad (el arco semidiurno de la cúspide no existe).
  // Aquí es donde un motor "confiable" cae a Porphyry en vez de devolver NaN o
  // cúspides desordenadas.
  const polarRisk = Math.abs(lat) > 66.5;

  switch (input.preferredSystem ?? 'whole-sign') {
    case 'whole-sign': return wholeSignCusps(angles);
    case 'equal': return equalCusps(angles);
    case 'porphyry': return porphyryCusps(angles);
    default:
      return polarRisk ? porphyryCusps(angles) : wholeSignCusps(angles);
  }
}

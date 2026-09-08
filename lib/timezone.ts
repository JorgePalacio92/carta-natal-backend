/**
 * Capa 2: TIMEZONE HISTÓRICO
 * --------------------------
 * Esta es la parte que de verdad diferencia un motor "confiable" de uno de juguete,
 * y es también la parte que astro.com NO resuelve con un algoritmo: Astrodienst mantiene
 * "ATLAS", una base de datos geográfica/horaria curada a mano durante décadas (actas de
 * nacimiento, diarios de época, leyes locales de cada municipio) — ver su propia
 * documentación pública en astro.com/cgi/atlan.cgi. Eso no es replicable con código;
 * es trabajo de investigación histórica acumulado.
 *
 * Lo que SÍ es un patrón de ingeniería replicable — y lo que usan la inmensa mayoría de
 * apps de astrología serias que no tienen un ATLAS propio (CircularNatalHoroscopeJS,
 * Kerykeion, flatlib, etc.) — es este pipeline de 3 pasos con fallback explícito:
 *
 *   1) Resolver la IANA tz id a partir de lat/lon (tz-lookup usa los polígonos de
 *      timezone-boundary-builder, la misma fuente que usa prácticamente todo el ecosistema).
 *   2) Si la fecha cae DESPUÉS de que esa zona empezó a tener reglas administrativas
 *      confiables en tzdata (el propio IANA tzdata documenta desde cuándo cada zona es
 *      fiable — antes de eso, en muchas zonas tzdata directamente inventa un offset LMT
 *      "de facto" y lo marca como tal), usamos el offset dado por el tzdata vigente en
 *      esa fecha exacta (Luxon ya trae DST histórico correcto, porque usa tzdata completo).
 *   3) Si la fecha es ANTERIOR al corte de fiabilidad -> fallback a Hora Media Local (LMT):
 *      offset = longitud / 15 (horas), sin DST. Esto es exactamente lo que hacían los
 *      relojes de la localidad antes de que existiera una hora estándar nacional, y es
 *      el fallback estándar documentado en la literatura astrológica (ver Cafe Astrology,
 *      AstrOccult) cuando no hay un registro histórico específico disponible.
 *
 * IMPORTANTE: LMT es un fallback razonable, NO un sustituto de investigación histórica real.
 * Para casos límite (ciudad con cambios de huso ad-hoc, guerra, ocupación) solo una tabla
 * curada tipo ATLAS da el dato correcto. Documenta siempre en la UI si el offset vino de
 * tzdata o de fallback LMT — la app de astro.com muestra explícitamente esta distinción.
 */

import { DateTime } from 'luxon';
// @ts-ignore - tz-lookup no trae tipos oficiales
import tzlookup from 'tz-lookup';

export type OffsetSource = 'tzdata' | 'lmt-fallback';

export interface ResolvedLocalTime {
  utc: Date;
  ianaZone: string;
  utcOffsetHours: number;
  source: OffsetSource;
}

/**
 * Corte de fiabilidad: antes de esta fecha (configurable por región si tienes datos
 * mejores) tzdata suele no tener registro fiable de reglas locales pre-industriales.
 * 1900 es un valor conservador y ampliamente usado en software astrológico de código
 * abierto como corte por defecto quando no hay una tabla histórica específica.
 */
const DEFAULT_RELIABILITY_CUTOFF = DateTime.utc(1900, 1, 1);

export function resolveLocalBirthTime(params: {
  year: number; month: number; day: number; hour: number; minute: number;
  latitude: number; longitude: number;
  reliabilityCutoff?: DateTime;
}): ResolvedLocalTime {
  const { year, month, day, hour, minute, latitude, longitude } = params;
  const cutoff = params.reliabilityCutoff ?? DEFAULT_RELIABILITY_CUTOFF;
  const ianaZone: string = tzlookup(latitude, longitude);

  // Interpretamos la fecha/hora "naive" (tal como la dice el usuario) en la zona IANA,
  // dejando que Luxon/tzdata resuelva el offset histórico (incluyendo DST de época) si
  // la fecha cae dentro del rango que tzdata considera fiable para esa zona.
  const asZoned = DateTime.fromObject(
    { year, month, day, hour, minute },
    { zone: ianaZone }
  );

  if (asZoned < cutoff) {
    const offsetHours = longitude / 15; // Hora Media Local pura, sin DST
    // BUG REAL encontrado validando contra astro.com (ver ARCHITECTURE.md, sección 7):
    // redondear el offset a minutos enteros introduce hasta ~30s de error, que en ARMC
    // se traduce en ~7' de Ascendente/MC (la Tierra gira ~15"/segundo de tiempo). Para
    // Londres 1875 (offset real de solo -40s) ese redondeo alcanzaba a duplicar el error.
    // Se debe operar en milisegundos, nunca redondear a minuto.
    const offsetMs = Math.round(offsetHours * 3600 * 1000);
    const utc = DateTime.fromObject(
      { year, month, day, hour, minute },
      { zone: 'utc' }
    ).minus({ milliseconds: offsetMs });
    return { utc: utc.toJSDate(), ianaZone, utcOffsetHours: offsetHours, source: 'lmt-fallback' };
  }

  return {
    utc: asZoned.toUTC().toJSDate(),
    ianaZone,
    utcOffsetHours: asZoned.offset / 60,
    source: 'tzdata',
  };
}

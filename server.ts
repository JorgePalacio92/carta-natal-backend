/**
 * Backend mínimo — "El Mapa del Alma", constructor de carta natal
 * ------------------------------------------------------------------
 * Expone un único endpoint: POST /api/carta-natal
 *
 * Usa:
 *  - lib/timezone.ts  -> pipeline tzdata->LMT ya validado y con el bug de
 *                        redondeo corregido (ver golden_test.ts).
 *  - sweph (nativo)   -> planetas + casas reales (incluye Placidus), la
 *                        misma Swiss Ephemeris que corre detrás de astro.com.
 *
 * Por qué sweph acá y no astronomy-engine: ambos ya están cross-validados
 * (diferencias de milésimas de grado), pero sweph nos da Placidus directo
 * sin reimplementar la iteración trascendente a mano — la recomendación que
 * ya estaba en ARCHITECTURE.md sección 4, ahora aplicada en el lugar correcto
 * (backend, no navegador, porque sweph es un addon nativo, no WASM).
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sweph from 'sweph';
import { resolveLocalBirthTime } from './lib/timezone';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---- Geocodificación: ciudad -> coordenadas ----
// Base curada de 13.912 ciudades (población >= 30.000 o capital de país),
// derivada de GeoNames vía el paquete "all-the-cities" (MIT). Se sirve como
// JSON estático precomputado (1.7 MB) para no depender de ninguna API externa
// en tiempo de ejecución -- coherente con el resto del proyecto (sin llamadas
// a terceros, todo el cálculo corre en un servidor propio).

interface CityEntry {
  name: string;
  country: string;
  countryName: string;
  lat: number;
  lon: number;
  population: number;
  isCapital: boolean;
}

const CITIES: CityEntry[] = JSON.parse(
  readFileSync(join(__dirname, 'cities_curated.json'), 'utf-8')
);

/** Quita acentos/diacríticos y pasa a minúsculas, para que "cordoba" encuentre "Córdoba". */
function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Índice pre-normalizado (se calcula una sola vez al arrancar, no en cada búsqueda).
const CITIES_INDEXED = CITIES.map((c) => ({ ...c, _normName: normalize(c.name) }));

interface CitySearchResult {
  name: string;
  country: string;
  countryName: string;
  lat: number;
  lon: number;
  isCapital: boolean;
  /** Texto listo para mostrar en un selector: "Córdoba, Argentina" */
  label: string;
}

function searchCities(query: string, limit = 10): CitySearchResult[] {
  const q = normalize(query);
  if (q.length < 2) return [];

  const scored = CITIES_INDEXED
    .filter((c) => c._normName.includes(q))
    .map((c) => {
      // El bono de "empieza con" debe dominar siempre sobre la población, incluso
      // frente a megaciudades de +15M de habitantes -- si no, una búsqueda corta
      // como "bu" mostraba Estambul antes que Buenos Aires. 100 millones asegura
      // que ninguna ciudad real (la más poblada del mundo tiene ~40M) le gane
      // a una coincidencia de prefijo real por pura población.
      const startsWith = c._normName.startsWith(q) ? 100_000_000 : 0;
      const capitalBonus = c.isCapital ? 500_000 : 0;
      // Población como desempate principal: entre dos ciudades que matchean
      // igual de bien el texto, mostrar primero la más conocida.
      const score = startsWith + capitalBonus + c.population;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ c }) => ({
      name: c.name,
      country: c.country,
      countryName: c.countryName,
      lat: c.lat,
      lon: c.lon,
      isCapital: c.isCapital,
      label: `${c.name}, ${c.countryName}`,
    }));

  return scored;
}


// ---- Tipos del contrato con el frontend (Claude Design lee esto) ----

type PlanetKey =
  | 'Sun' | 'Moon' | 'Mercury' | 'Venus' | 'Mars'
  | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune' | 'Pluto';

const SWEPH_PLANET_ID: Record<PlanetKey, number> = {
  Sun: 0, Moon: 1, Mercury: 2, Venus: 3, Mars: 4,
  Jupiter: 5, Saturn: 6, Uranus: 7, Neptune: 8, Pluto: 9,
};

const SIGNS_ES = [
  'Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo',
  'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis',
];

interface BirthRequest {
  year: number; month: number; day: number;
  hour?: number; minute?: number; // ausentes -> fallback carta solar
  latitude: number; longitude: number;
  houseSystem?: 'P' | 'W' | 'E' | 'O'; // Placidus, Whole Sign, Equal, Porphyry (letras propias de Swiss Ephemeris)
}

interface PlanetResult {
  key: PlanetKey;
  longitude: number;
  sign: string;
  signDegree: number;
  retrograde: boolean;
}

interface ChartResponse {
  utc: string | null;
  timezoneSource: 'tzdata' | 'lmt-fallback' | 'n/a-unknown-time';
  planets: PlanetResult[];
  houses: {
    system: string;
    isFallback: boolean;
    ascendant: number;
    midheaven: number;
    cusps: number[];
  };
}

function signOf(lon: number): { sign: string; degree: number } {
  const norm = ((lon % 360) + 360) % 360;
  const idx = Math.floor(norm / 30);
  return { sign: SIGNS_ES[idx], degree: norm - idx * 30 };
}

// SEFLG_SPEED (256) para poder derivar retrogradación (velocidad negativa).
// SEFLG_MOSEPH (4) = Moshier, sin archivos de datos JPL externos: ~1" de precisión,
// ya validado en golden_test.ts contra astro.com (diferencias de 0-27").
const SEFLG_MOSEPH = 4;
const SEFLG_SPEED = 256;

function computePlanets(julianDayUT: number): PlanetResult[] {
  return (Object.keys(SWEPH_PLANET_ID) as PlanetKey[]).map((key) => {
    const id = SWEPH_PLANET_ID[key];
    const result = sweph.calc_ut(julianDayUT, id, SEFLG_MOSEPH | SEFLG_SPEED);
    if (result.error) throw new Error(`sweph.calc_ut falló para ${key}: ${result.error}`);
    // sweph.calc_ut devuelve [longitud, latitud, distancia, velocidad_long,
    // velocidad_lat, velocidad_dist] -- la velocidad en longitud (la que define
    // retrogradación) es el índice 3, NO el 4 (ese es velocidad en latitud).
    // Bug real encontrado al probar esta ruta: con el índice mal puesto, el Sol
    // aparecía como retrógrado, algo astronómicamente imposible -- señal clara
    // de que se estaba leyendo el campo equivocado del array.
    const [longitude, , , speedLongitude] = result.data;
    const { sign, degree } = signOf(longitude);
    return { key, longitude, sign, signDegree: degree, retrograde: speedLongitude < 0 };
  });
}

function computeHousesReal(julianDayUT: number, lat: number, lon: number, system: string) {
  const result = sweph.houses(julianDayUT, lat, lon, system);
  if (result.error) throw new Error(`sweph.houses falló: ${result.error}`);
  return {
    system,
    isFallback: false,
    ascendant: result.data.points[0],
    midheaven: result.data.points[1],
    cusps: result.data.houses,
  };
}

function computeSolarFallbackHouses(sunLongitude: number) {
  const cusps = Array.from({ length: 12 }, (_, i) => ((sunLongitude + i * 30) % 360 + 360) % 360);
  return {
    system: 'solar-fallback',
    isFallback: true,
    ascendant: sunLongitude,
    midheaven: (sunLongitude + 270) % 360,
    cusps,
  };
}

function computeChart(input: BirthRequest): ChartResponse {
  const hasTime = input.hour != null && input.minute != null;
  const houseSystem = input.houseSystem ?? 'P'; // Placidus por defecto, como astro.com/astroseek

  if (!hasTime) {
    // Sin hora -> mediodía UTC como referencia neutra (mismo criterio que lib/chart.ts)
    const jd = sweph.julday(input.year, input.month, input.day, 12, sweph.constants.SE_GREG_CAL);
    const planets = computePlanets(jd);
    const sun = planets.find((p) => p.key === 'Sun')!;
    return {
      utc: null,
      timezoneSource: 'n/a-unknown-time',
      planets,
      houses: computeSolarFallbackHouses(sun.longitude),
    };
  }

  const resolved = resolveLocalBirthTime({
    year: input.year, month: input.month, day: input.day,
    hour: input.hour!, minute: input.minute!,
    latitude: input.latitude, longitude: input.longitude,
  });

  const utcDate = resolved.utc;
  const decimalHourUTC = utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60 + utcDate.getUTCSeconds() / 3600;
  const jd = sweph.julday(
    utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate(),
    decimalHourUTC, sweph.constants.SE_GREG_CAL,
  );

  const planets = computePlanets(jd);
  const houses = computeHousesReal(jd, input.latitude, input.longitude, houseSystem);

  return {
    utc: utcDate.toISOString(),
    timezoneSource: resolved.source,
    planets,
    houses,
  };
}

// ---- Servidor HTTP mínimo (sin framework, para que el deploy no dependa de más nada) ----

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', // ajustar al dominio real de Claude Design en producción
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, swephVersion: sweph.version() });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/ciudades')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = url.searchParams.get('q') ?? '';
    const results = searchCities(q);
    sendJson(res, 200, { results });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/carta-natal') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const input = JSON.parse(body) as BirthRequest;

        if (input.year == null || input.month == null || input.day == null ||
            input.latitude == null || input.longitude == null) {
          sendJson(res, 400, { error: 'Faltan campos obligatorios: year, month, day, latitude, longitude.' });
          return;
        }

        const chart = computeChart(input);
        sendJson(res, 200, chart);
      } catch (err) {
        console.error('Error calculando carta:', err);
        sendJson(res, 500, { error: 'No se pudo calcular la carta.', detail: String(err) });
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'Ruta no encontrada. Usá POST /api/carta-natal o GET /health.' });
});

server.listen(PORT, () => {
  console.log(`Servidor de carta natal escuchando en :${PORT}`);
  console.log(`Swiss Ephemeris (sweph) versión: ${sweph.version()}`);
});

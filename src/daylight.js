// What time of day it is, in the only unit the map cares about: where the sun is.
//
// Mapbox Standard has four lighting presets — dawn, day, dusk, night — and until
// now the app picked one from the THEME: light meant day, dark meant night. That
// is a statement about the interface, not about the world, and it is why the map
// could sit in broad daylight at eleven at night.
//
// NOT CLOCK HOURS, and this is the whole reason there is arithmetic in this file
// rather than a table. "Dusk is 6pm" is wrong at my campus by up to an hour and a half
// in each direction: the sun sets at 16:47 in December and 20:15 in June, and a
// map that goes dark at six is an hour early in summer and an hour late in
// winter — exactly the two times of year anybody would notice. So the sun's
// actual elevation is computed, and the presets are hung off the angles that
// name themselves:
//
//   above +6 deg   DAY     full daylight, shadows short and hard
//   -0.833 to +6   DAWN or DUSK, by whether the sun is rising or setting
//   below -0.833   NIGHT   the sun's disc is under the horizon
//
// -0.833 degrees is sunrise/sunset proper rather than zero — the standard
// definition, which allows for the sun's own radius (0.267) and for atmospheric
// refraction lifting the disc into view before it is geometrically up (0.566).
// +6 is the top of civil twilight, the point at which the sky stops being a
// colour and starts being a light source.
//
// The algorithm is NOAA's, in the form everyone uses: mean longitude and mean
// anomaly of the sun from the Julian day, an equation-of-centre correction to
// get the true ecliptic longitude, then declination and the equation of time,
// and finally an hour angle from local solar time. It is good to well under a
// minute of arc over any date this app will ever be opened on, which is three
// orders of magnitude better than the question being asked of it — the answer is
// one of four words.
//
// No timezone handling anywhere, deliberately. The hour angle is computed from
// UTC and the observer's LONGITUDE, which is what actually determines where the
// sun is; a timezone is a political fiction laid over that, and asking the
// browser for one would introduce a way to be wrong about a thing already known.

const rad = Math.PI / 180;
const deg = 180 / Math.PI;

/** Sunrise and sunset, allowing for the sun's radius and for refraction. */
export const HORIZON_DEG = -0.833;
/** The top of civil twilight: above this the sky is lit rather than lighting. */
export const CIVIL_DEG = 6;

/**
 * The sun's elevation above the horizon, in degrees, and whether it is rising.
 *
 * `rising` is not derived from the elevation — you cannot tell a rising sun from
 * a setting one by its height — but from the hour angle, which is negative
 * before local solar noon and positive after. That is the only thing separating
 * dawn from dusk, and both are the same handful of degrees.
 */
export function sunAt(date, lon, lat) {
  // Julian day, then centuries from J2000.0.
  const jd = date.getTime() / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545) / 36_525;

  // Geometric mean longitude and mean anomaly, degrees.
  const meanLong = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35_999.05029 - t * 0.0001537);

  // Equation of centre: the correction from a circular orbit to the real one.
  const centre = Math.sin(meanAnom * rad) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * meanAnom * rad) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * meanAnom * rad) * 0.000289;
  const trueLong = meanLong + centre;

  // Apparent longitude, and the obliquity of the ecliptic it is measured against.
  const omega = 125.04 - 1934.136 * t;
  const apparent = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const obliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = obliq + 0.00256 * Math.cos(omega * rad);

  const declination = Math.asin(Math.sin(obliqCorr * rad) * Math.sin(apparent * rad)) * deg;

  // The equation of time, in minutes: how far apparent solar time runs ahead of
  // or behind mean time. This is what makes solar noon wander by a quarter hour
  // across the year, and dropping it is the usual way this calculation goes
  // quietly wrong.
  const y = Math.tan((obliqCorr / 2) * rad) ** 2;
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const eqTime = 4 * deg * (
    y * Math.sin(2 * meanLong * rad)
    - 2 * eccent * Math.sin(meanAnom * rad)
    + 4 * eccent * y * Math.sin(meanAnom * rad) * Math.cos(2 * meanLong * rad)
    - 0.5 * y * y * Math.sin(4 * meanLong * rad)
    - 1.25 * eccent * eccent * Math.sin(2 * meanAnom * rad)
  );

  // True solar time in minutes from midnight, then the hour angle: 15 degrees
  // per hour, zero at local solar noon.
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes()
    + date.getUTCSeconds() / 60;
  const solarMinutes = (utcMinutes + eqTime + 4 * lon + 1440) % 1440;
  const hourAngle = solarMinutes / 4 - 180;

  const elevation = Math.asin(
    Math.sin(lat * rad) * Math.sin(declination * rad)
    + Math.cos(lat * rad) * Math.cos(declination * rad) * Math.cos(hourAngle * rad),
  ) * deg;

  return { elevation, rising: hourAngle < 0, declination, hourAngle };
}

/**
 * Which of Standard's four presets the sky is currently doing.
 *
 * Returns one of `dawn`, `day`, `dusk`, `night` — never `auto`, which is the
 * bench's word for "ask this function" rather than a state the sky can be in.
 */
export function lightPresetAt(date, lon, lat) {
  const { elevation, rising } = sunAt(date, lon, lat);
  if (elevation > CIVIL_DEG) return 'day';
  if (elevation > HORIZON_DEG) return rising ? 'dawn' : 'dusk';
  return 'night';
}

/**
 * How long until the preset could next change, in ms, clamped to something sane.
 *
 * A POLL RATHER THAN A SCHEDULE, and cheaply, because the alternative is solving
 * for the moment the sun crosses each threshold — which is a root-find over a
 * function that is itself an approximation, to decide when to change one word.
 * The sun moves at most a quarter of a degree a minute at this latitude, so a
 * check every minute cannot be more than about fifteen seconds late on a
 * boundary, and fifteen seconds is not visible in a lighting change that Mapbox
 * cross-fades anyway.
 *
 * Longer when the sun is nowhere near a boundary: at noon and at midnight there
 * is nothing to catch for hours, and a timer that wakes a phone every minute to
 * decide it is still daytime is a battery cost with no user.
 */
export const CHECK_MIN_MS = 60_000;
export const CHECK_MAX_MS = 15 * 60_000;
export function nextCheckMs(date, lon, lat) {
  const { elevation } = sunAt(date, lon, lat);
  // Distance in degrees to whichever threshold is nearest.
  const gap = Math.min(
    Math.abs(elevation - HORIZON_DEG),
    Math.abs(elevation - CIVIL_DEG),
  );
  // The sun's fastest apparent rate is 15 deg/hour times cos(latitude), which at
  // my campus is about 0.196 deg/minute. Minutes to the boundary, at worst.
  const minutes = gap / 0.196;
  return Math.max(CHECK_MIN_MS, Math.min(CHECK_MAX_MS, minutes * 60_000));
}

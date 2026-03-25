#!/usr/bin/env node

import { WhoopClient } from './whoop-client.mjs';

// --- Arg parsing ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || null;
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'json' || key === 'today' || key === 'last') {
        flags[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      }
    }
  }
  return { command, flags };
}

// --- Utility functions ---

function msToHm(ms) {
  if (!ms) return '0:00';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

function msToMin(ms) {
  return ms ? (ms / 60000).toFixed(1) : '0';
}

// --- Sport name mapping ---

const SPORT_NAMES = {
  weightlifting_msk: 'Strength training (weightlifting)',
  weightlifting: 'Strength training',
  strength_training: 'Strength training',
  functional_fitness: 'Functional fitness',
  running: 'Running',
  cycling: 'Cycling',
  swimming: 'Swimming',
  walking: 'Walking',
  yoga: 'Yoga',
  pilates: 'Pilates',
  basketball: 'Basketball',
  soccer: 'Soccer',
  tennis: 'Tennis',
  hiking: 'Hiking',
  skiing: 'Skiing',
  snowboarding: 'Snowboarding',
  rowing: 'Rowing',
  crossfit: 'CrossFit',
  boxing: 'Boxing',
  climbing: 'Climbing',
  dance: 'Dance',
  hiit: 'HIIT',
};

function prettySportName(raw) {
  if (!raw) return 'Unknown';
  const lower = raw.toLowerCase();
  if (SPORT_NAMES[lower]) return SPORT_NAMES[lower];
  const normalized = lower.replace(/-/g, '_');
  if (SPORT_NAMES[normalized]) return SPORT_NAMES[normalized];
  return lower.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// --- Date helpers ---

function computeDateRange(flags) {
  const now = new Date();
  let start = null;
  let end = null;

  if (flags.today) {
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    start = midnight.toISOString();
    end = now.toISOString();
  } else if (flags.last) {
    start = new Date(now.getTime() - 48 * 3600000).toISOString();
    end = now.toISOString();
  } else if (flags.days) {
    start = new Date(now.getTime() - parseInt(flags.days) * 86400000).toISOString();
    end = now.toISOString();
  } else {
    start = flags.start || null;
    end = flags.end || null;
  }
  return { start, end };
}

// --- Profile command ---

async function cmdProfile(client, flags) {
  const profile = await client.getProfile();
  const body = await client.getBodyMeasurements();

  if (flags.json) {
    console.log(JSON.stringify({ profile, body_measurements: body }, null, 2));
    return;
  }

  const heightM = body.height_meter || 0;
  const weightKg = body.weight_kilogram || 0;

  console.log('\nWHOOP User Profile\n');
  console.log('-'.repeat(50));
  console.log(`  Name:     ${profile.first_name} ${profile.last_name}`);
  console.log(`  Email:    ${profile.email}`);
  console.log(`  User ID:  ${profile.user_id}`);
  console.log();
  console.log('Body Measurements:');
  console.log(`  Height:   ${heightM} m  (${(heightM * 100).toFixed(1)} cm)`);
  console.log(`  Weight:   ${Number(weightKg).toFixed(1)} kg (${(weightKg * 2.20462).toFixed(1)} lbs)`);
  console.log(`  Max HR:   ${body.max_heart_rate} bpm`);
  console.log();
}

// --- Recovery command ---

async function cmdRecovery(client, flags) {
  const { start, end } = computeDateRange(flags);
  const limit = flags.limit ? parseInt(flags.limit) : 25;
  const response = await client.getRecoveryCollection(start, end, limit);

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const records = response.records || [];
  if (!records.length) {
    console.log('No recovery data found for the specified period.');
    return;
  }

  console.log(`\nRecovery Data (${records.length} records)\n`);
  console.log('-'.repeat(70));

  for (const record of records) {
    const score = record.score || {};
    const scoreState = record.score_state || 'UNKNOWN';
    const date = (record.created_at || '').slice(0, 10);

    if (scoreState !== 'SCORED') {
      console.log(`Date: ${date}  [${scoreState}]`);
      console.log();
      continue;
    }

    console.log(`Date: ${date}`);
    console.log(`  Recovery Score: ${Number(score.recovery_score).toFixed(1)}%`);
    console.log(`  HRV (RMSSD):   ${(score.hrv_rmssd_milli || 0).toFixed(1)} ms`);
    console.log(`  Resting HR:    ${Number(score.resting_heart_rate).toFixed(1)} bpm`);
    if (score.spo2_percentage) {
      console.log(`  SpO2:          ${score.spo2_percentage.toFixed(1)}%`);
    }
    if (score.skin_temp_celsius) {
      console.log(`  Skin Temp:     ${score.skin_temp_celsius.toFixed(1)}°C`);
    }
    if (score.user_calibrating) {
      console.log('  ⚠️  User is calibrating');
    }
    console.log();
  }
}

// --- Sleep command ---

async function cmdSleep(client, flags) {
  const { start, end } = computeDateRange(flags);
  let limit = flags.limit ? parseInt(flags.limit) : 25;
  if (flags.last) limit = 1;
  const response = await client.getSleepCollection(start, end, limit);

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const records = response.records || [];
  if (!records.length) {
    console.log('No sleep data found for the specified period.');
    return;
  }

  console.log(`\nSleep Data (${records.length} records)\n`);
  console.log('-'.repeat(70));

  for (const record of records) {
    const score = record.score || {};
    const stages = score.stage_summary || {};
    const needed = score.sleep_needed || {};
    const scoreState = record.score_state || 'UNKNOWN';
    const date = (record.start || '').slice(0, 10);
    const napTag = record.nap ? ' (NAP)' : '';

    if (scoreState !== 'SCORED') {
      console.log(`Date: ${date}${napTag}  [${scoreState}]`);
      console.log();
      continue;
    }

    const totalSleepMs =
      (stages.total_light_sleep_time_milli || 0) +
      (stages.total_slow_wave_sleep_time_milli || 0) +
      (stages.total_rem_sleep_time_milli || 0);

    console.log(`Date: ${date}${napTag}`);
    console.log(`  Total Sleep:   ${msToHm(totalSleepMs)}  (In bed: ${msToHm(stages.total_in_bed_time_milli)})`);
    console.log(`    REM: ${msToHm(stages.total_rem_sleep_time_milli)}  |  Deep: ${msToHm(stages.total_slow_wave_sleep_time_milli)}  |  Light: ${msToHm(stages.total_light_sleep_time_milli)}  |  Awake: ${msToHm(stages.total_awake_time_milli)}`);
    console.log(`  Performance:   ${Number(score.sleep_performance_percentage).toFixed(1)}%`);
    if (score.sleep_efficiency_percentage) {
      console.log(`  Efficiency:    ${score.sleep_efficiency_percentage.toFixed(1)}%  |  Consistency: ${Number(score.sleep_consistency_percentage).toFixed(1)}%`);
    }
    if (score.respiratory_rate) {
      console.log(`  Resp. Rate:    ${score.respiratory_rate.toFixed(1)} bpm`);
    }
    console.log(`  Disturbances:  ${stages.disturbance_count}  |  Sleep Cycles: ${stages.sleep_cycle_count}`);
    console.log(`  Sleep Needed:  ${msToHm(needed.baseline_milli)}  |  Debt: ${msToHm(needed.need_from_sleep_debt_milli)}`);
    console.log();
  }
}

// --- Workouts command ---

async function cmdWorkouts(client, flags) {
  const { start, end } = computeDateRange(flags);
  const limit = flags.limit ? parseInt(flags.limit) : 25;
  const response = await client.getWorkoutCollection(start, end, limit);

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  let records = response.records || [];

  if (flags.sport) {
    const sportFilter = flags.sport.toLowerCase();
    records = records.filter(r => (r.sport_name || '').toLowerCase() === sportFilter);
  }

  if (!records.length) {
    console.log('No workout data found for the specified period.');
    return;
  }

  console.log(`\nWorkout Data (${records.length} records)\n`);
  console.log('-'.repeat(70));

  for (const record of records) {
    const score = record.score || {};
    const zones = score.zone_durations || {};
    const scoreState = record.score_state || 'UNKNOWN';
    const date = (record.start || '').slice(0, 10);
    const sport = prettySportName(record.sport_name);

    if (scoreState !== 'SCORED') {
      console.log(`Date: ${date} | Sport: ${sport}  [${scoreState}]`);
      console.log();
      continue;
    }

    const totalMs = ['zero', 'one', 'two', 'three', 'four', 'five']
      .reduce((sum, z) => sum + (zones[`zone_${z}_milli`] || 0), 0);

    console.log(`Date: ${date} | Sport: ${sport}`);
    console.log(`  Strain:   ${(score.strain || 0).toFixed(1)}`);
    console.log(`  Duration: ${msToMin(totalMs)} min`);
    console.log(`  HR:       ${score.average_heart_rate} avg / ${score.max_heart_rate} max bpm`);
    if (score.kilojoule) {
      console.log(`  Calories: ${Math.round(score.kilojoule * 0.239006)} kcal`);
    }
    if (score.distance_meter) {
      console.log(`  Distance: ${(score.distance_meter / 1000).toFixed(2)} km`);
    }
    if (score.altitude_gain_meter) {
      console.log(`  Elevation: +${Math.round(score.altitude_gain_meter)} m`);
    }
    if (score.percent_recorded != null) {
      console.log(`  Recorded: ${Number(score.percent_recorded).toFixed(1)}%`);
    }

    const zoneParts = [0, 1, 2, 3, 4, 5]
      .map(i => {
        const key = `zone_${['zero', 'one', 'two', 'three', 'four', 'five'][i]}_milli`;
        const val = msToMin(zones[key]);
        return parseFloat(val) > 0 ? `Z${i}: ${val}m` : null;
      })
      .filter(Boolean);
    if (zoneParts.length) {
      console.log(`  HR Zones: ${zoneParts.join(' | ')}`);
    }
    console.log();
  }
}

// --- Cycles command ---

async function cmdCycles(client, flags) {
  const { start, end } = computeDateRange(flags);
  const limit = flags.limit ? parseInt(flags.limit) : 25;
  const response = await client.getCycleCollection(start, end, limit);

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const records = response.records || [];
  if (!records.length) {
    console.log('No cycle data found for the specified period.');
    return;
  }

  console.log(`\nDaily Cycles (${records.length} records)\n`);
  console.log('-'.repeat(70));

  for (const record of records) {
    const score = record.score || {};
    const scoreState = record.score_state || 'UNKNOWN';
    const date = (record.start || '').slice(0, 10);

    if (scoreState !== 'SCORED') {
      console.log(`Date: ${date}  [${scoreState}]`);
      console.log();
      continue;
    }

    const kcal = Math.round((score.kilojoule || 0) * 0.239006);
    console.log(`Date: ${date}`);
    console.log(`  Strain:   ${(score.strain || 0).toFixed(1)} / 21`);
    console.log(`  HR:       ${score.average_heart_rate} avg / ${score.max_heart_rate} max bpm`);
    console.log(`  Energy:   ${kcal} kcal  (${(score.kilojoule || 0).toFixed(1)} kJ)`);
    console.log();
  }
}

// --- Main ---

const USAGE = `Usage: whoop <command> [options]

Commands:
  profile                     User profile + body measurements
  recovery                    Recovery scores
  sleep                       Sleep data
  workouts                    Workout data
  cycles                      Daily strain (cycle) data

Options:
  --today                     Today's data (recovery, cycles)
  --last                      Last night's sleep
  --days <N>                  Past N days
  --start <YYYY-MM-DD>        Start date
  --end <YYYY-MM-DD>          End date
  --limit <N>                 Max records (default 25)
  --sport <name>              Filter workouts by sport
  --json                      Output raw JSON`;

const { command, flags } = parseArgs(process.argv);

if (!command) {
  console.log(USAGE);
  process.exit(0);
}

try {
  const client = new WhoopClient();

  switch (command) {
    case 'profile':
      await cmdProfile(client, flags);
      break;
    case 'recovery':
      await cmdRecovery(client, flags);
      break;
    case 'sleep':
      await cmdSleep(client, flags);
      break;
    case 'workouts':
      await cmdWorkouts(client, flags);
      break;
    case 'cycles':
      await cmdCycles(client, flags);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  startService,
  stopService,
  freePort,
  createRequester,
  children,
} from "./harness.js";

function summarize(results) {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const count = (status) =>
    results.filter((r) => r.body.status === status).length;
  return {
    total: results.length,
    paid: count("PAID"),
    failed: count("FAILED"),
    pending: count("PENDING"),
    minMs: durations[0],
    maxMs: durations.at(-1),
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
  };
}
async function context(mode, config, options) {
  const monitor = createRequester(1);
  const requester = createRequester();
  const reader = createRequester(1);
  let bank, fee;
  try {
    bank = await startService("bank", {
      PORT: String(options.bankPort ?? 4002),
      ...config,
    });
    fee = await startService("fee", {
      PORT: String(options.feePort ?? 4001),
      BANK_URL: bank.url,
      CLIENT_MODE: mode,
    });
  } catch (e) {
    monitor.close();
    requester.close();
    reader.close();
    await stopService(bank?.child);
    throw e;
  }
  const fees = () => reader.request(`${fee.url}/students/1/fees`);
  const pay = (amount = 1000) =>
    requester.request(`${fee.url}/students/1/payments`, { amount });
  const stats = async () => ({
    raw: (await monitor.request(`${bank.url}/stats`)).body,
    monitorConnections: monitor.connections,
  });
  return {
    pay,
    fees,
    stats,
    async close() {
      requester.close();
      reader.close();
      monitor.close();
      await stopService(fee.child);
      await stopService(bank.child);
    },
  };
}
async function measuredRun(mode, config, options, execute) {
  const ctx = await context(mode, config, options);
  try {
    const before = await ctx.stats();
    const outstandingBefore = (await ctx.fees()).body.outstanding;
    const start = performance.now();
    const { results, ...details } = await execute(ctx);
    const totalMs = performance.now() - start;
    const after = await ctx.stats();
    const outstandingAfter = (await ctx.fees()).body.outstanding;
    const statsDelta = Object.fromEntries(
      Object.keys(before.raw).map((key) => [
        key,
        after.raw[key] - before.raw[key],
      ]),
    );
    const monitorConnections =
      after.monitorConnections - before.monitorConnections;
    const bankConnections = statsDelta.connections - monitorConnections;
    return {
      config,
      results,
      summary: summarize(results),
      totalMs,
      outstandingBefore,
      outstandingAfter,
      statsBefore: before.raw,
      statsAfter: after.raw,
      statsDelta,
      monitorConnections,
      bankConnections,
      ...details,
    };
  } finally {
    await ctx.close();
  }
}
async function batch(pay, count, concurrency) {
  const results = new Array(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const index = next++;
        results[index] = await pay();
      }
    }),
  );
  return results;
}
const debtMatches = (run) =>
  run.outstandingBefore - run.outstandingAfter === run.summary.paid * 1000;

export async function runScenario(scenario, mode, options = {}) {
  if (
    !["1", "2", "3", "4"].includes(scenario) ||
    !["baseline", "resilient"].includes(mode)
  )
    throw new Error("Invalid scenario or mode");
  const record = {
    scenario,
    mode,
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runs: [],
  };
  if (scenario === "1") {
    for (const requestedPort of options.bankPorts ?? [4002, 4999]) {
      const bankPort = requestedPort || (await freePort());
      const requester = createRequester();
      const monitor = createRequester(1);
      let fee, bank;
      try {
        const bankUrl = `http://localhost:${bankPort}`;
        fee = await startService("fee", {
          PORT: String(options.feePort ?? 4001),
          BANK_URL: bankUrl,
          CLIENT_MODE: mode,
        });
        const pay = () =>
          requester.request(`${fee.url}/students/1/payments`, { amount: 1000 });
        const outstandingBefore = (
          await requester.request(`${fee.url}/students/1/fees`)
        ).body.outstanding;
        const offline = await pay();
        const read = await requester.request(`${fee.url}/students/1/fees`);
        bank = await startService("bank", { PORT: String(bankPort) });
        const recovered = await pay();
        const statsAfter = (await monitor.request(`${bank.url}/stats`)).body;
        const outstandingAfter = (
          await requester.request(`${fee.url}/students/1/fees`)
        ).body.outstanding;
        record.runs.push({
          bankUrl,
          offline,
          read,
          recovered,
          statsAfter,
          outstandingBefore,
          outstandingAfter,
          pass:
            offline.code === 503 &&
            offline.body.status === "FAILED" &&
            offline.durationMs < 1500 &&
            read.code === 200 &&
            read.durationMs < 300 &&
            recovered.code === 201 &&
            outstandingBefore - outstandingAfter === 1000,
        });
      } finally {
        requester.close();
        monitor.close();
        await stopService(fee?.child);
        await stopService(bank?.child);
      }
    }
  }
  if (scenario === "2") {
    const run = await measuredRun(
      mode,
      { DELAY_MS: "5000" },
      options,
      async (ctx) => {
        const single = await ctx.pay();
        const waiting = batch(() => ctx.pay(), 20, 20);
        const reads = [];
        for (let i = 0; i < 8; i++) {
          await delay(100);
          reads.push(await ctx.fees());
        }
        return { results: [single, ...(await waiting)], reads };
      },
    );
    run.pass =
      run.results.every(
        (r) =>
          r.code === 504 && r.body.status === "PENDING" && r.durationMs <= 4500,
      ) &&
      run.reads.every((r) => r.code === 200 && r.durationMs < 300) &&
      debtMatches(run);
    record.runs.push(run);
  }
  if (scenario === "3") {
    const run = await measuredRun(mode, {}, options, async (ctx) => {
      const start = performance.now();
      const results = await batch(() => ctx.pay(), 200, 10);
      const loadMs = performance.now() - start;
      const loadStats = await ctx.stats();
      await delay(6000);
      const afterIdle = await batch(() => ctx.pay(), 5, 5);
      return { results, loadMs, loadStats, afterIdle };
    });
    run.loadBankConnections =
      run.loadStats.raw.connections - run.statsBefore.connections; // monitor socket is still warm during load
    run.pass =
      run.summary.paid === 200 &&
      run.loadBankConnections <= 20 &&
      run.afterIdle.every((r) => r.code === 201) &&
      run.outstandingBefore - run.outstandingAfter === 205000;
    record.runs.push(run);
  }
  if (scenario === "4") {
    for (const fault of ["DROP_RATE", "FAIL_RATE"]) {
      const run = await measuredRun(
        mode,
        { [fault]: "0.3" },
        options,
        async (ctx) => ({ results: await batch(() => ctx.pay(), 60, 1) }),
      );
      run.pass =
        run.summary.paid >= 54 &&
        run.statsAfter.duplicates === 0 &&
        debtMatches(run) &&
        run.summary.maxMs <= 4500;
      if (fault === "DROP_RATE")
        run.pass &&= run.results.every(
          (r) =>
            r.code === 201 || (r.code === 504 && r.body.status === "PENDING"),
        );
      record.runs.push(run);
    }
    const refusal = await measuredRun(mode, {}, options, async (ctx) => ({
      results: [await ctx.pay(25_000_000)],
    }));
    refusal.pass =
      refusal.results[0].code === 402 &&
      refusal.results[0].body.status === "FAILED" &&
      refusal.statsDelta.requests === 1 &&
      refusal.statsDelta.charges === 0 &&
      refusal.outstandingBefore === refusal.outstandingAfter;
    record.runs.push(refusal);
  }
  record.pass = record.runs.every((r) => r.pass);
  return record;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const scenario = get("--scenario", "all");
  const mode = get("--mode", "resilient");
  const scenarios = scenario === "all" ? ["1", "2", "3", "4"] : [scenario];
  const modes = mode === "both" ? ["baseline", "resilient"] : [mode];
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await Promise.all([...children].map(stopService));
      process.exit(130);
    });
  try {
    const output = fileURLToPath(new URL("../results/", import.meta.url));
    await mkdir(output, { recursive: true });
    let success = true;
    for (const selectedMode of modes)
      for (const selectedScenario of scenarios) {
        const result = await runScenario(selectedScenario, selectedMode);
        await writeFile(
          `${output}scenario-${selectedScenario}-${selectedMode}.json`,
          JSON.stringify(result, null, 2) + "\n",
        );
        console.log(
          `${selectedMode} scenario ${selectedScenario}: ${result.pass ? "PASS" : "FAIL"} ${result.runs.map((r) => (r.summary ? `${r.summary.paid}/${r.summary.total} PAID` : `offline ${r.offline.code} -> ${r.recovered.code}`)).join("; ")}`,
        );
        if (selectedMode === "resilient") success &&= result.pass;
      }
    if (!success) process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await Promise.all([...children].map(stopService));
  }
}

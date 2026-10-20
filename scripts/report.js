import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
const ms = (value) => Number(value).toFixed(1);
export function renderReport(records) {
  const lines = [
    "# Kết quả thực nghiệm Lab 3 thanh toán học phí",
    "",
    "Số liệu dưới đây được sinh từ các file JSON trong `results/`, dùng hai tiến trình Node.js riêng. Baseline đã có validation, idempotency và deadline 4 giây, nhưng chưa dùng keep-alive hoặc retry; resilient là chế độ hoàn chỉnh. Vì vậy baseline có thể đã đạt tình huống 1 và 2. FAIL ở baseline được giữ nguyên để so sánh.",
    "",
    "## Môi trường và cách đo",
    "",
    ...records.map(
      (r) =>
        `- Tình huống ${r.scenario}, ${r.mode}: ${r.at}; Node ${r.node}; ${r.platform}/${r.arch}; kết quả ${r.pass ? "PASS" : "FAIL"}.`,
    ),
    "",
    "Mỗi đợt reset cả hai service; riêng tình huống 1 giữ nguyên Fee Service khi bật ngân hàng. Thời gian đo bằng đồng hồ đơn điệu, đơn vị ms. Số kết nối ngân hàng đã loại kết nối giám sát /stats; raw counters và số kết nối giám sát được lưu trong JSON. FAIL_RATE/DROP_RATE dùng Math.random thật, không chọn lại đợt đo để làm đẹp kết quả.",
    "",
    "## Bảng so sánh",
    "",
    "| Tình huống | Chế độ | PAID | FAILED / PENDING | Thời gian | TCP cho charge | Requests / charges / duplicates | Nợ giảm VND | Kết quả |",
    "|---|---|---:|---:|---|---:|---|---:|---|",
  ];
  for (const record of records)
    for (const run of record.runs) {
      const verdict = run.pass ? "PASS" : "FAIL";
      if (record.scenario === "1") {
        const outcomes = [run.offline, run.recovered];
        const count = (status) =>
          outcomes.filter((r) => r.body.status === status).length;
        lines.push(
          `| 1 (${run.bankUrl}) | ${record.mode} | ${count("PAID")}/2 | ${count("FAILED")} / ${count("PENDING")} | offline ${ms(run.offline.durationMs)}; phục hồi ${ms(run.recovered.durationMs)}; GET ${ms(run.read.durationMs)} | ${run.statsAfter.connections - 1} | ${run.statsAfter.requests} / ${run.statsAfter.charges} / ${run.statsAfter.duplicates} | ${run.outstandingBefore - run.outstandingAfter} | ${verdict} |`,
        );
        continue;
      }
      const label =
        record.scenario === "4"
          ? run.config.DROP_RATE
            ? "4a DROP_RATE=0.3"
            : run.config.FAIL_RATE
              ? "4b FAIL_RATE=0.3"
              : "4c hạn mức"
          : record.scenario;
      const timing =
        record.scenario === "3"
          ? `200 lệnh: ${ms(run.loadMs)}; max ${ms(run.summary.maxMs)}`
          : `max ${ms(run.summary.maxMs)}; p95 ${ms(run.summary.p95Ms)}`;
      const tcp =
        record.scenario === "3"
          ? `${run.loadBankConnections} (sau idle tổng ${run.bankConnections})`
          : run.bankConnections;
      lines.push(
        `| ${label} | ${record.mode} | ${run.summary.paid}/${run.summary.total} | ${run.summary.failed} / ${run.summary.pending} | ${timing} | ${tcp} | ${run.statsDelta.requests} / ${run.statsDelta.charges} / ${run.statsDelta.duplicates} | ${run.outstandingBefore - run.outstandingAfter} | ${verdict} |`,
      );
    }
  lines.push("", "## Kiểm tra bổ sung", "");
  for (const record of records)
    for (const run of record.runs) {
      if (record.scenario === "2")
        lines.push(
          `- ${record.mode}: 1 thanh toán riêng và 20 thanh toán đồng thời; GET công nợ chậm nhất ${ms(Math.max(...run.reads.map((r) => r.durationMs)))} ms.`,
        );
      if (record.scenario === "3")
        lines.push(
          `- ${record.mode}: sau nhàn rỗi 6 giây, ${run.afterIdle.filter((r) => r.code === 201).length}/5 lệnh tiếp theo thành công. Counters cuối đợt gồm 200 + 5 lệnh, trong khi tỷ lệ PAID và số TCP cho bài tải được tính riêng cho 200 lệnh đầu.`,
        );
    }
  lines.push(
    "",
    "## Giải thích kết quả",
    "",
    "Keep-alive cho phép tái sử dụng tối đa 10 socket thay vì mở một TCP connection cho mỗi charge. Sau 6 giây nhàn rỗi, socket cũ đã bị ngân hàng đóng; client mở lại kết nối khi cần.",
    "",
    "Retry giữ nguyên reference và Idempotency-Key. Khi ngân hàng đã charge rồi cắt kết nối, lần gửi lại lấy kết quả đã lưu. HTTP 500 trước charge được thử lại tối đa ba lần trong cùng deadline; HTTP 402 không thử lại.",
    "",
    "PENDING giữ nguyên theo phạm vi đã chốt, không có đối soát. Fee chỉ giảm công nợ cho PAID. Khi còn PENDING đã charge, charges có thể lớn hơn PAID; điều đó không có nghĩa là trừ tiền trùng. duplicates đo số charge lặp cùng reference và phải bằng 0.",
    "",
    "Tỷ lệ lỗi 0.3 là xác suất, nên tỷ lệ thành công và thời gian thay đổi giữa các đợt đo. Các kiểm thử hồi quy dùng chuỗi lỗi xác định; benchmark dùng lỗi ngẫu nhiên thực tế. Báo cáo phản ánh một đợt đo cụ thể, không phải bảo đảm thời gian trên mọi máy.",
    "",
    "Chạy lại: `npm run benchmark -- --scenario all --mode both` rồi `npm run report`. Chế độ resilient trả exit code khác 0 nếu một tiêu chí không đạt; baseline không đạt tiêu chí vẫn được ghi nhận trong báo cáo.",
    "",
  );
  return lines.join("\n");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = (await readdir(`${root}results`))
    .filter((f) => /^scenario-[1-4]-(baseline|resilient)\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error("No results: run the benchmark first");
  const records = await Promise.all(
    files.map((f) => readFile(`${root}results/${f}`, "utf8").then(JSON.parse)),
  );
  await mkdir(`${root}docs`, { recursive: true });
  await writeFile(`${root}docs/results.md`, renderReport(records));
  console.log(
    "Written docs/results.md from",
    files.length,
    "measured result files",
  );
}

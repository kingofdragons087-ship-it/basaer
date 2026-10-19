require("dotenv").config();
const { Client } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير موجود في بيئة Termux.");
    console.error("هذا الاختبار المحلي لا يقرأ متغيرات Render تلقائيًا.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  try {
    await client.connect();
    const result = await client.query(
      "SELECT current_database() AS database, current_user AS role, version() AS version"
    );
    console.log("نجح الاتصال بقاعدة PostgreSQL.");
    console.log("قاعدة البيانات:", result.rows[0].database);
    console.log("الدور:", result.rows[0].role);
    console.log("إصدار PostgreSQL:", result.rows[0].version.split(",")[0]);
  } catch (error) {
    console.error("فشل الاتصال:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();

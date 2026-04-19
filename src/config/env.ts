import dotenv from "dotenv";
import path from "path";

const result = dotenv.config({ path: path.resolve(process.cwd(), ".env") });

console.log("[ENV] cwd:", process.cwd());
console.log("[ENV] .env carregado:", result.error ? `ERRO - ${result.error.message}` : "OK");
console.log("[ENV] SECRET_TOKEN:", process.env.SECRET_TOKEN ? "OK" : "MISSING");
console.log("[ENV] ISSUER:", process.env.ISSUER ? "OK" : "MISSING");

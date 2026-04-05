import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";

async function main() {
  const payload = {
    id: "68f10f38757f2ab14f38d970", // <-- ID real do admin no gateway-db
    role: "admin"
  };

  if (!process.env.SECRET_TOKEN) {
    throw new Error("❌ SECRET_TOKEN não encontrado no .env");
  }

  if (!process.env.ISSUER) {
    throw new Error("❌ ISSUER não encontrado no .env");
  }

  const token = jwt.sign(payload, process.env.SECRET_TOKEN as string, {
    expiresIn: "1d",
    issuer: process.env.ISSUER,
  });

  console.log("✅ Token gerado com sucesso:");
  console.log(token);
}

main();

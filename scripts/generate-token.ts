import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const token = jwt.sign(
  {
    id: "68f131eb52d8f49bcaab5a6f", // o _id do usuário que você criou
    role: "seller" // pode ser "seller" ou "admin" dependendo do caso
  },
  process.env.SECRET_TOKEN as string,
  {
    expiresIn: "24h",
    issuer: process.env.ISSUER,
  }
);

console.log("Bearer Token:", token);

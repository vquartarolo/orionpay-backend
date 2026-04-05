import mongoose from "mongoose";

// NÃO precisa de dotenv no Railway (ele já usa process.env automático)

const MONGO_URI = process.env.MONGO_URI;

export const connectDB = async (): Promise<void> => {
  try {
    if (!MONGO_URI) {
      console.error("❌ MONGO_URI não definida");
      process.exit(1);
    }

    console.log("🔌 Conectando ao MongoDB...");

    await mongoose.connect(MONGO_URI);

    console.log("🔥 MongoDB conectado com sucesso!");
  } catch (error) {
    console.error("🚨 Erro ao conectar ao MongoDB:", error);
    process.exit(1);
  }
};

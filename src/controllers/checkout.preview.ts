// src/controllers/checkout.preview.ts
import { RequestHandler } from "express";
import { Checkout } from "../models/checkout.model";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";

export const renderCheckoutPreview: RequestHandler = async (req, res) => {
  try {
    const { id } = req.query;
    if (!id || typeof id !== "string") {
      res.status(400).send("ID do checkout é obrigatório.");
      return;
    }

    const checkout = await Checkout.findById(id).lean();
    if (!checkout) {
      res.status(404).send("Checkout não encontrado.");
      return;
    }

    const user = await User.findById(checkout.userId).lean();
    if (!user || !user.status) {
      res.status(403).send("Usuário inativo ou inválido.");
      return;
    }

    const product = await Product.findById(checkout.productId).lean();
    if (!product) {
      res.status(404).send("Produto não encontrado.");
      return;
    }

    const backgroundColor = checkout.background === "dark" ? "#111" : "#fff";
    const textColor = checkout.background === "dark" ? "#fff" : "#000";

    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <title>Preview - ${product.name}</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background-color: ${backgroundColor};
              color: ${textColor};
              padding: 2rem;
              margin: 0;
            }
            .container {
              max-width: 600px;
              margin: auto;
              border: 1px solid #ccc;
              padding: 2rem;
              border-radius: 10px;
              background: ${checkout.background === "dark" ? "#1a1a1a" : "#f9f9f9"};
            }
            .banner {
              width: 100%;
              max-height: 200px;
              object-fit: cover;
              margin-bottom: 1.5rem;
              border-radius: 6px;
            }
            .button {
              background-color: ${checkout.colors};
              color: white;
              padding: 12px 24px;
              text-decoration: none;
              font-size: 16px;
              border-radius: 6px;
              display: inline-block;
              margin-top: 1rem;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <img src="${checkout.settings.bannerUrl || "https://via.placeholder.com/600x200?text=Banner"}" class="banner" alt="Banner do produto" />
            <h1>${product.name}</h1>
            <p>Preço: R$ ${product.price.toFixed(2)}</p>
            <a href="#" class="button">Comprar agora</a>
          </div>
        </body>
      </html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(html);
  } catch (error) {
    console.error("❌ Erro em renderCheckoutPreview:", error);
    res.status(500).send("Erro ao carregar preview do checkout.");
  }
};

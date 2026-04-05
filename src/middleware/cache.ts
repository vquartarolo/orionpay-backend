import { Request, Response, NextFunction } from "express";
import NodeCache from "node-cache";

const cache = new NodeCache();

/**
 * 🧠 Middleware de cache reutilizável
 * @param ttl Tempo em segundos para manter o cache
 */
export const cacheMiddleware = (ttl: number) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.originalUrl; // 🔑 chave baseada na rota + query
    const cachedData = cache.get(key);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      res.status(200).json(cachedData);
      return; // ✅ encerra aqui e não segue para o controller
    }

    // intercepta o método res.json
    const originalJson = res.json.bind(res);
    res.json = (body: any): Response => {
      cache.set(key, body, ttl); // armazena no cache
      res.setHeader("X-Cache", "MISS");
      return originalJson(body);
    };

    next();
  };
};

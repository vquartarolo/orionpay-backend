declare global {
  namespace Express {
    interface Request {
      resolvedDomain?: Record<string, any> | null;
      resolvedCheckout?: Record<string, any> | null;
    }
  }
}

export {};

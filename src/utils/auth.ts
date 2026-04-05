import { decodeToken } from "../config/auth";
import { User } from "../models/user.model";

export const getUserFromToken = async (token?: string) => {
  if (!token) return null;
  const payload = await decodeToken(token.replace("Bearer ", ""));
  if (!payload?.id) return null;
  const user = await User.findById(payload.id).lean();
  return user || null;
};

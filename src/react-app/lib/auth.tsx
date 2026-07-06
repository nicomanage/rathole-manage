import { createContext, useContext } from "react";
import type { Role } from "@shared/types";

export interface AuthState {
  username?: string;
  role?: Role;
  isAdmin: boolean;
}

export const AuthContext = createContext<AuthState>({ isAdmin: false });

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

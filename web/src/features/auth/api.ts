import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../app/queryKeys.ts";
import { request } from "../../shared/lib/http.ts";
import type { LoginRequestDto, SessionDto } from "../../types.ts";

/**
 * Who is signed in.
 *
 * The session lives in an HttpOnly cookie, so the browser attaches it and this
 * code can neither read nor forge it. That is the point: a token in
 * localStorage is readable by any script that gets onto the page.
 *
 * A 401 here is not a failure to report - it is the answer "nobody", and it is
 * what makes the sign-in screen appear. So it resolves to null rather than
 * throwing, and nothing retries it.
 */
export function useSession() {
  return useQuery({
    queryKey: qk.session(),
    queryFn: async () => {
      try {
        return await request<SessionDto>("/api/auth/me");
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequestDto) =>
      request<SessionDto>("/api/auth/login", { method: "POST", body }),
    onSuccess: (session) => {
      client.setQueryData(qk.session(), session);
      // Anything cached from a previous account must not be shown to this one.
      void client.invalidateQueries();
    },
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequestDto & { code?: string }) =>
      request<SessionDto>("/api/auth/register", { method: "POST", body }),
    onSuccess: (session) => {
      client.setQueryData(qk.session(), session);
      void client.invalidateQueries();
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSettled: () => {
      // Cleared unconditionally: if the request failed the cookie may still be
      // gone, and leaving another account's notebooks on screen is worse.
      client.setQueryData(qk.session(), null);
      client.clear();
    },
  });
}

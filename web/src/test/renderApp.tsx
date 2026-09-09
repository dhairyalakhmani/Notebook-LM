import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { routes } from "../app/routes.tsx";
import { ToastProvider } from "../shared/ui/Toast.tsx";

export function renderApp({ url = "/n/networking" }: { url?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const view = render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ToastProvider>,
  );
  return { ...view, router, client };
}

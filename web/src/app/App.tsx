import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { createQueryClient } from "./queryClient.ts";
import { router } from "./routes.tsx";
import { ToastProvider, useToast } from "../shared/ui/Toast.tsx";

export function App() {
  return (
    <ToastProvider>
      <WithQueryClient />
    </ToastProvider>
  );
}

function WithQueryClient() {
  const toast = useToast();
  const [client] = useState(() => createQueryClient(toast));
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

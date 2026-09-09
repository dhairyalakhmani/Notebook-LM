import { createBrowserRouter } from "react-router";
import { AppError, NotFound } from "./AppError.tsx";
import { NotebookIndex } from "./NotebookIndex.tsx";
import { NotebookLayout } from "./NotebookLayout.tsx";
import { RootLayout } from "./RootLayout.tsx";
import { ChatView } from "../features/chat/ChatView.tsx";
import { SourceDetailView } from "../features/sources/SourceDetailView.tsx";

export const routes = [
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <AppError />,
    children: [
      { index: true, element: <NotebookIndex /> },
      {
        path: "n/:notebook",
        element: <NotebookLayout />,
        children: [
          { index: true, element: <ChatView /> },
          { path: "source/:documentId", element: <SourceDetailView /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);

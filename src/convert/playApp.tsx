import React from "react";
import { createRoot } from "react-dom/client";
import "./SwfStudioApp.css";
import { SwfStudioApp } from "./SwfStudioApp.tsx";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

createRoot(root).render(
  <SwfStudioApp />,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BadgeWorkshop } from "./BadgeWorkshop";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BadgeWorkshop />
  </StrictMode>,
);

/**
 * Phase 5: tour page ids live in this dependency-free leaf — not in
 * lib/tour.ts, which is a "use client" module importing driver.js + CSS.
 * The API route (/api/tour) validates the page suffix against ALL_TOUR_PAGES
 * and must not drag the browser tour engine (or its stylesheet) into Node.
 */

export type TourPage =
  | "dashboard"
  | "lists"
  | "contacts"
  | "companies"
  | "workflows"
  | "inbox"
  | "settings";

export const ALL_TOUR_PAGES: TourPage[] = ["dashboard", "lists", "contacts", "companies", "workflows", "inbox", "settings"];

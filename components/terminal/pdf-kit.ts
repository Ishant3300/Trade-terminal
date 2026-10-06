import type { jsPDF } from "jspdf";

// Shared look for all PDF reports: palette, number formats, header band, footer.

export type RGB = [number, number, number];
export const INK: RGB = [28, 36, 48];
export const NAVY: RGB = [31, 36, 45];
export const ACCENT: RGB = [30, 96, 210];
export const MUTED: RGB = [107, 118, 134];
export const RED: RGB = [183, 28, 28];
export const GREEN: RGB = [26, 127, 55];
export const BLUE: RGB = [13, 71, 161];
export const LINE: RGB = [216, 220, 227];
export const MARGIN = 12;
export const FIRM = "Trade Terminal";

const nf = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const amt = (n: number) => nf.format(Math.abs(n) < 0.005 ? 0 : n);
export const qty = (n: number) => nf0.format(n);
export const crDr = (n: number) => (Math.abs(n) < 0.005 ? "0.00" : `${nf.format(Math.abs(n))} ${n >= 0 ? "Cr" : "Dr"}`);
export const dmy = (d: string) => d.split("-").reverse().join("-");
export const generatedAt = () => {
  const now = new Date();
  return `${now.toLocaleDateString("en-GB").replace(/\//g, "-")} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

/** jsPDF + AutoTable, loaded only when a PDF is requested. */
export async function loadPdf() {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  return { doc, autoTable };
}

/** Dark header band with the firm on the left and the document title on the right. */
export function drawBand(doc: jsPDF, title: string, subtitle: string) {
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, W, 24, "F");
  doc.setFillColor(...ACCENT);
  doc.rect(0, 24, W, 1.2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(FIRM.toUpperCase(), MARGIN, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(170, 178, 190);
  doc.text("JOBBING BACK OFFICE", MARGIN, 17.5);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(title, W - MARGIN, 12, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 206, 214);
  doc.text(subtitle, W - MARGIN, 17.5, { align: "right" });
}

/** Footer line with a caption, the computer-generated note and page numbers on every page. */
export function drawFooters(doc: jsPDF, caption: string) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, H - 10, W - MARGIN, H - 10);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(`${FIRM.toUpperCase()}  ·  ${caption}`, MARGIN, H - 6);
    doc.text("This is a computer-generated statement.", W / 2, H - 6, { align: "center" });
    doc.text(`Page ${p} of ${pages}`, W - MARGIN, H - 6, { align: "right" });
  }
}

/** Common AutoTable styling (navy head, light rules, grey foot). */
export const tableTheme = {
  theme: "plain" as const,
  styles: {
    font: "helvetica",
    fontSize: 8.2,
    textColor: INK,
    cellPadding: { top: 2, bottom: 2, left: 2.2, right: 2.2 },
    lineColor: LINE,
    lineWidth: { bottom: 0.2 },
    valign: "middle" as const,
  },
  headStyles: { fillColor: NAVY, textColor: [255, 255, 255] as RGB, fontStyle: "bold" as const, fontSize: 8.2, lineWidth: 0 },
  footStyles: { fillColor: [228, 232, 238] as RGB, textColor: INK, fontStyle: "bold" as const, fontSize: 8.6, lineWidth: 0 },
  alternateRowStyles: { fillColor: [250, 251, 253] as RGB },
};

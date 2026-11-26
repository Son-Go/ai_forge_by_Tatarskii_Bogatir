// A minimal valid PDF for exercising the existing binary download contract.
// Fixed ASCII content intentionally has no customer details, prices or invoice fields.
export function demoQuotePdf(): Uint8Array<ArrayBuffer> {
  const stream = 'BT /F1 22 Tf 48 760 Td (SOFTLINE - DEMONSTRATION) Tj 0 -40 Td /F1 16 Tf (Quote draft / Local prototype) Tj 0 -32 Td /F1 11 Tf (SYNTHETIC TEST DOCUMENT - NO COMMERCIAL VALIDITY) Tj 0 -24 Td (Not an invoice. No real order, price or customer details.) Tj 0 -24 Td (Production PDF is generated and validated by Backend.) Tj 0 -24 Td (Manager review is required before any commercial use.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

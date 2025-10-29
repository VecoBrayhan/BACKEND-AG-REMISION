import { GoogleGenerativeAI } from "@google/generative-ai";
// Usa 'require' que es más robusto para este tipo de librerías en Node.js
const pdfParse = require("pdf-parse");
import * as xlsx from "xlsx";
// Importa los tipos de Vercel
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Inicializa Gemini (la API Key la pondremos en Vercel)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Define el "handler" de Vercel
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Vercel recibe los datos en 'req.body'
  const { fileBase64, fileName } = req.body;

  try {
    // 1. Decodificar el archivo
    const fileBuffer = Buffer.from(fileBase64, "base64");

    // 2. Extraer el texto
    let text = "";
    if (fileName.endsWith(".pdf")) {
      const pdfData = await pdfParse(fileBuffer);
      text = pdfData.text;
    } else if (fileName.endsWith(".xls") || fileName.endsWith(".xlsx")) {
      const workbook = xlsx.read(fileBuffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      text = xlsx.utils.sheet_to_csv(worksheet);
    } else {
      return res.status(400).json({ error: "Tipo de archivo no soportado." });
    }

    // 3. Preparar el Prompt para Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" }); // <-- USA ESTE MODELO EXACTO
    const prompt = `
      Eres un asistente experto en logística de Perú que extrae datos de guías de remisión.
      Analiza el siguiente texto y extrae los campos clave.
      Responde SOLAMENTE con un objeto JSON.

      Texto a analizar:
      """
      ${text}
      """

      Formato JSON requerido:
      {
        "date": "YYYY-MM-DD (Fecha principal del documento)",
        "ruc": " (El RUC del transportista o emisor)",
        "extractedData": {
          "fechaLlegada": "YYYY-MM-DD",
          "fechaRegistro": "YYYY-MM-DD",
          "costoTransporte": "150.00 (flotante, sin 'S/'.)",
          "productos": "(Extrae una lista de productos, cantidad y unidad si es posible)"
        }
      }
    `;

    // 4. Llamar a la IA
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let jsonResponse = response.text();

    // Limpiar la respuesta (Gemini a veces añade ```json)
    jsonResponse = jsonResponse.replace(/```json/g, "").replace(/```/g, "");

    // 5. Devolver el JSON parseado a la app KMP
    return res.status(200).json(JSON.parse(jsonResponse));

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error al procesar el archivo con IA." });
  }
}
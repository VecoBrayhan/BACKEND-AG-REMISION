import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
// import * as pdfParse from "pdf-parse"; // Error 1: Eliminado. Usamos 'require' abajo.
import * as xlsx from "xlsx";
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Usamos 'require' para pdf-parse por si el 'import' falla en Vercel
const pdfParser = require("pdf-parse");

// Configuración de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// --- PROMPTS SEPARADOS ---
const textPrompt = `
      Eres un asistente experto en logística de Perú que extrae datos de guías de remisión a partir de texto.
      Analiza el siguiente texto y extrae los campos clave.
      Responde SOLAMENTE con un objeto JSON.

      Texto a analizar:
      """
      __TEXTO_A_ANALIZAR__
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

const imagePrompt = `
      Eres un asistente experto en logística de Perú que extrae datos (OCR) de imágenes de guías de remisión.
      Analiza la siguiente imagen y extrae los campos clave.
      Responde SOLAMENTE con un objeto JSON.

      Formato JSON requerido:
      {
        "date": "YYYY-MM-DD (Fecha principal del documento)",
        "ruc": " (El RUC del transportista o emisor)",
        "extractedData": {
          "fechaLegada": "YYYY-MM-DD",
          "fechaRegistro": "YYYY-MM-DD",
          "costoTransporte": "150.00 (flotante, sin 'S/'.)",
          "productos": "(Extrae una lista de productos, cantidad y unidad si es posible)"
        }
      }
    `;
// -------------------------


export default async function handler(
    req: VercelRequest,
    res: VercelResponse
) {
    const { fileBase64, fileName } = req.body;
    
    // Fallo rápido si no hay datos
    if (!fileBase64 || !fileName) {
        return res.status(400).json({ error: "Faltan fileBase64 o fileName." });
    }

    try {
        const fileBuffer = Buffer.from(fileBase64, "base64");
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025", safetySettings });

        let result;
        const fileExt = fileName.split('.').pop()?.toLowerCase();

        if (fileExt === "pdf") {
            // --- Lógica de PDF ---
            console.log("Procesando PDF...");
            const pdfData = await pdfParser(fileBuffer);
            // Error 2: Corregido. Usa el nuevo placeholder
            const prompt = textPrompt.replace("__TEXTO_A_ANALIZAR__", pdfData.text);
            result = await model.generateContent(prompt);

        } else if (fileExt === "xls" || fileExt === "xlsx") {
            // --- Lógica de Excel ---
            console.log("Procesando Excel...");
            const workbook = xlsx.read(fileBuffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const text = xlsx.utils.sheet_to_csv(worksheet);
            // Error 3: Corregido. Usa el nuevo placeholder
            const prompt = textPrompt.replace("__TEXTO_A_ANALIZAR__", text);
            result = await model.generateContent(prompt);

        } else if (fileExt === "png" || fileExt === "jpg" || fileExt === "jpeg") {
            // --- NUEVA Lógica de Imagen ---
            console.log(`Procesando Imagen (${fileExt})...`);
            
            // Define el tipo MIME correcto
            const mimeType = `image/${fileExt === "jpg" ? "jpeg" : fileExt}`;

            // Define la parte de la imagen para la API de Gemini
            const imagePart = {
                inlineData: {
                    data: fileBase64, // Ya está en Base64
                    mimeType: mimeType
                },
            };

            // Envía el prompt de imagen + la imagen
            result = await model.generateContent([imagePrompt, imagePart]);

        } else {
            console.log(`Tipo de archivo no soportado: ${fileExt}`);
            return res.status(400).json({ error: `Tipo de archivo no soportado: .${fileExt}` });
        }

        // --- Respuesta (común para todos) ---
        const response = await result.response;
        let jsonResponse = response.text();
        jsonResponse = jsonResponse.replace(/```json/g, "").replace(/```/g, "");

        console.log("Respuesta de IA generada, enviando al cliente.");
        return res.status(200).json(JSON.parse(jsonResponse));

    } catch (error: any) {
        console.error("Error en handler de Vercel:", error);
        
        // Captura de errores de API de Google
        if (error.name === 'GoogleGenerativeAIFetchError') {
             return res.status(500).json({ error: `Error de API de Gemini: ${error.message}` });
        }

        return res.status(500).json({ error: `Error al procesar el archivo: ${error.message}` });
    }
}


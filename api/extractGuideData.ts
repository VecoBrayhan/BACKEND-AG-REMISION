import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
// Usa 'require' para pdf-parse por si el 'import' falla en Vercel
const pdfParser = require("pdf-parse");
import * as xlsx from "xlsx";
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Configuración de Vercel (sin cambios)
export const config = {
    api: {
        bodyParser: false, // ¡Importante! Le decimos a Vercel que nos dé el stream crudo
    },
};

// Función para parsear el body (sin cambios)
async function parseJsonBody(req: VercelRequest): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { // Acumula los "trozos" de datos
            body += chunk.toString();
        });
        req.on('end', () => { // Cuando termina de llegar
            try {
                if (body) {
                    resolve(JSON.parse(body)); // Parsea el string completo
                } else {
                    reject(new Error("Request body is empty"));
                }
            } catch (e) {
                console.error("Invalid JSON body received:", body);
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on('error', (err) => {
            reject(err);
        });
    });
}

// Configuración de Gemini (sin cambios)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// --- PROMPTS (MODIFICADOS CON VALIDACIÓN) ---

const textPrompt = `
    Eres un asistente experto en logística de Perú que extrae datos de guías de remisión.
    Tu primera tarea es validar el texto.
    1.  Analiza el siguiente texto y determina si parece ser una guía de remisión, factura o documento logístico de Perú.
    2.  Si NO es un documento relevante (ej. es un ensayo, un email aleatorio, un poema), responde ÚNICAMENTE con este JSON:
        {"error": "El documento no parece ser una guía de remisión válida."}
    3.  Si SÍ es un documento relevante, extrae los campos clave. Responde SOLAMENTE con el objeto JSON de datos.

    Texto a analizar:
    """
    __TEXTO_A_ANALIZAR__
    """

    Formato JSON de datos (SOLO si es válido):
    {
      "date": "YYYY-MM-DD (Fecha principal del documento)",
      "ruc": " (El RUC del transportista o emisor)",
      "extractedData": {
        "fechaLlegada": "YYYY-MM-DD",
        "fechaRegistro": "YYYY-MM-DD",
        "costoTransporte": "150.00 (flotante, sin 'S/'.)",
        "productos": "[{\"descripcion\": \"Nombre del producto\", \"cantidad\": 10, \"unidad\": \"UND\"}]"
      }
    }
    `;

const imagePrompt = `
    Eres un asistente experto en logística de Perú que extrae datos (OCR) de imágenes de guías de remisión.
    Tu primera tarea es validar la imagen.
    1.  Analiza la siguiente imagen y determina si es una guía de remisión, factura o documento logístico de Perú.
    2.  Si NO es un documento relevante (ej. es una foto de una persona, un paisaje, un gato, etc.), responde ÚNICAMENTE con este JSON:
        {"error": "La imagen no parece ser una guía de remisión válida."}
    3.  Si SÍ es una guía de remisión, extrae los campos clave (OCR). Responde SOLAMENTE con el objeto JSON de datos.

    Formato JSON de datos (SOLO si es válido):
    {
      "date": "YYYY-MM-DD (Fecha principal del documento)",
      "ruc": " (El RUC del transportista o emisor)",
      "extractedData": {
        "fechaLlegada": "YYYY-MM-DD", 
        "fechaRegistro": "YYYY-MM-DD",
        "costoTransporte": "150.00 (flotante, sin 'S/'.)",
        "productos": "[{\"descripcion\": \"Nombre del producto\", \"cantidad\": 10, \"unidad\": \"UND\"}]"
      }
    }
    `;
// -----------------------------------------


export default async function handler(
    req: VercelRequest,
    res: VercelResponse
) {
    try {
        // --- PASO 1: Parsear el body manualmente ---
        const body = await parseJsonBody(req);
        
        // --- PASO 2: Destructurar 'body' ---
        const { fileBase64, fileName } = body;
        
        if (!fileBase64 || !fileName) {
            return res.status(400).json({ error: "Faltan fileBase64 o fileName en el body." });
        }

        const fileBuffer = Buffer.from(fileBase64, "base64");
        
        // --- CORRECCIÓN: Usar un modelo multimodal que acepte texto E imágenes ---
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025", safetySettings});

        let result;
        const fileExt = fileName.split('.').pop()?.toLowerCase();

        if (fileExt === "pdf") {
            // --- Lógica de PDF ---
            console.log("Procesando PDF...");
            const pdfData = await pdfParser(fileBuffer);
            const prompt = textPrompt.replace("__TEXTO_A_ANALIZAR__", pdfData.text);
            result = await model.generateContent(prompt);

        } else if (fileExt === "xls" || fileExt === "xlsx") {
            // --- Lógica de Excel ---
            console.log("Procesando Excel...");
            const workbook = xlsx.read(fileBuffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const text = xlsx.utils.sheet_to_csv(worksheet);
            const prompt = textPrompt.replace("__TEXTO_A_ANALIZAR__", text);
            result = await model.generateContent(prompt);

        } else if (fileExt === "png" || fileExt === "jpg" || fileExt === "jpeg") {
            // --- Lógica de Imagen ---
            console.log(`Procesando Imagen (${fileExt})...`);
            
            const mimeType = `image/${fileExt === "jpg" ? "jpeg" : fileExt}`;

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

        // --- RESPUESTA Y VALIDACIÓN (MODIFICADO) ---
        const response = await result.response;
        let jsonResponseText = response.text();
        jsonResponseText = jsonResponseText.replace(/```json/g, "").replace(/```/g, "");

        console.log("Respuesta de IA recibida:", jsonResponseText);

        let parsedResponse;
        try {
            parsedResponse = JSON.parse(jsonResponseText);
        } catch (e) {
            console.error("Error al parsear JSON de Gemini:", e);
            console.error("JSON problemático:", jsonResponseText);
            throw new Error("La respuesta de la IA no tuvo un formato JSON válido.");
        }

        // --- ¡AQUÍ ESTÁ LA VALIDACIÓN! ---
        // Comprueba si la IA devolvió el JSON de error que le pedimos
        if (parsedResponse.error) {
            console.log(`Validación de IA fallida: ${parsedResponse.error}`);
            // 422: Unprocessable Entity (La sintaxis está bien, pero el contenido no)
            // Este es el mensaje que pediste.
            return res.status(422).json({ error: parsedResponse.error });
        }
        // ---------------------------------

        console.log("Validación de IA exitosa. Enviando al cliente.");
        // Si no hay error, el JSON es el de los datos
        return res.status(200).json(parsedResponse);

    } catch (error: any) {
        console.error("Error en handler de Vercel:", error.message);
        
        if (error.name === 'GoogleGenerativeAIFetchError') {
             return res.status(500).json({ error: `Error de API de Gemini: ${error.message}` });
        }
        // Captura el error de JSON inválido que lanzamos arriba
        if (error.message.includes("formato JSON válido")) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(500).json({ error: `Error al procesar el archivo: ${error.message}` });
    }
}
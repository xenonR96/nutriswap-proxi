require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const NodeCache = require('node-cache');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Create cache instances
const tokenCache = new NodeCache({ stdTTL: parseInt(process.env.TOKEN_CACHE_TTL) || 3500 });
const foodCache = new NodeCache({ stdTTL: parseInt(process.env.FOOD_CACHE_TTL) || 86400 });
const reportRateCache = new NodeCache({ stdTTL: 3600 });

const productReportsRoot = path.join(__dirname, 'product-reports');
if (!fs.existsSync(productReportsRoot)) {
  fs.mkdirSync(productReportsRoot, { recursive: true });
}

const productReportUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const barcode = sanitizeBarcode(req.body?.barcode) || 'unknown';
      const dir = path.join(productReportsRoot, barcode);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Invalid image type. Only JPEG and PNG are allowed.'));
    }
  },
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Remote swap content (served to iOS app at /content/v1/swaps_{lang}.json)
const contentV1Dir = path.join(__dirname, 'content', 'v1');
app.use('/content/v1', express.static(contentV1Dir, {
  maxAge: '1h',
  fallthrough: true,
}));

// Health check endpoint
app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Proxy server is up and running' });
});

// Route to search for foods
app.get('/api/food/search', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query) {
      return res.status(400).json({ 
        code: 400, 
        message: 'Search query is required' 
      });
    }
    
    // Check cache first
    const cacheKey = `food_search_${query}`;
    const cachedResult = foodCache.get(cacheKey);
    
    if (cachedResult) {
      console.log(`[CACHE HIT] Found cached result for "${query}"`);
      return res.json(cachedResult);
    }
    
    // Get access token
    const accessToken = await getAccessToken();
    
    if (!accessToken) {
      return res.status(500).json({ 
        code: 500, 
        message: 'Failed to authenticate with FatSecret API' 
      });
    }
    
    // Construct the FatSecret API URL
    const params = new URLSearchParams({
      method: 'foods.search',
      search_expression: query,
      format: 'json',
      max_results: 50
    });
    
    const apiUrl = `${process.env.FATSECRET_API_URL}?${params.toString()}`;
    
    // Make the request to FatSecret API
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });
    
    // Process and transform the response
    const transformedResults = transformFoodResults(response.data);
    
    // Cache the results
    foodCache.set(cacheKey, transformedResults);
    
    // Return the transformed results
    res.json(transformedResults);
    
  } catch (error) {
    console.error('Error searching for foods:', error.message);
    
    // Handle different error types
    if (error.response) {
      // The request was made and the server responded with a status code outside of 2xx
      return res.status(error.response.status).json({
        code: error.response.status,
        message: error.response.data.message || 'Error from FatSecret API'
      });
    } else if (error.request) {
      // The request was made but no response was received
      return res.status(503).json({
        code: 503,
        message: 'No response from FatSecret API'
      });
    } else {
      // Something happened in setting up the request
      return res.status(500).json({
        code: 500,
        message: error.message || 'Unknown error occurred'
      });
    }
  }
});

// Route to get food details
app.get('/api/food/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check cache first
    const cacheKey = `food_details_${id}`;
    const cachedResult = foodCache.get(cacheKey);
    
    if (cachedResult) {
      console.log(`[CACHE HIT] Found cached result for food ID "${id}"`);
      return res.json(cachedResult);
    }
    
    // Get access token
    const accessToken = await getAccessToken();
    
    if (!accessToken) {
      return res.status(500).json({ 
        code: 500, 
        message: 'Failed to authenticate with FatSecret API' 
      });
    }
    
    // Construct the FatSecret API URL
    const params = new URLSearchParams({
      method: 'food.get',
      food_id: id,
      format: 'json'
    });
    
    const apiUrl = `${process.env.FATSECRET_API_URL}?${params.toString()}`;
    
    // Make the request to FatSecret API
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });
    
    // Process and transform the response
    const transformedResult = transformFoodDetails(response.data);
    
    // Cache the result
    foodCache.set(cacheKey, transformedResult);
    
    // Return the transformed result
    res.json(transformedResult);
    
  } catch (error) {
    console.error('Error getting food details:', error.message);
    
    // Handle different error types appropriately
    if (error.response) {
      return res.status(error.response.status).json({
        code: error.response.status,
        message: error.response.data.message || 'Error from FatSecret API'
      });
    } else if (error.request) {
      return res.status(503).json({
        code: 503,
        message: 'No response from FatSecret API'
      });
    } else {
      return res.status(500).json({
        code: 500,
        message: error.message || 'Unknown error occurred'
      });
    }
  }
});

// Helper function to get access token (with caching)
async function getAccessToken() {
  // Check if we have a cached token
  const cachedToken = tokenCache.get('access_token');
  if (cachedToken) {
    console.log('[CACHE HIT] Using cached access token');
    return cachedToken;
  }
  
  try {
    console.log('[CACHE MISS] Requesting new access token');
    
    // Prepare request for token
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic');
    params.append('client_id', process.env.FATSECRET_CLIENT_ID);
    params.append('client_secret', process.env.FATSECRET_CLIENT_SECRET);
    
    // Make the request
    const response = await axios.post(process.env.FATSECRET_TOKEN_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    // Cache the token for future requests
    const { access_token, expires_in } = response.data;
    tokenCache.set('access_token', access_token, expires_in - 100); // Set TTL slightly less than actual expiry
    
    return access_token;
  } catch (error) {
    console.error('Error getting access token:', error.message);
    return null;
  }
}

// Helper function to transform food search results
function transformFoodResults(data) {
  try {
    const foodList = data.foods?.food || [];
    
    if (!Array.isArray(foodList)) {
      // Handle case where only one food is returned
      return [transformSingleFood(foodList)];
    }
    
    return foodList.map(transformSingleFood);
  } catch (error) {
    console.error('Error transforming food results:', error.message);
    return [];
  }
}

// Helper function to transform a single food item
function transformSingleFood(foodItem) {
  const { food_id, food_name, food_description, brand_name } = foodItem;
  
  // Extract nutrition values from the description
  const calories = extractCalories(food_description);
  const protein = extractNutrient(food_description, 'Protein');
  const carbs = extractNutrient(food_description, 'Carbs');
  const fat = extractNutrient(food_description, 'Fat');
  
  // Extract serving size with improved pattern matching
  const servingInfo = extractServingInfo(food_description);
  
  // Determine food type (Brand or Generic)
  const foodType = brand_name ? 'Brand' : 'Generic';
  
  return {
    id: food_id,
    name: food_name,
    description: food_description,
    food_type: foodType,
    brand_name: brand_name || null,
    calories: calories,
    protein: protein,
    carbs: carbs,
    fat: fat,
    servingSize: servingInfo.size,
    servingUnit: servingInfo.unit,
    servingText: servingInfo.text
  };
}

// Helper function to extract serving information
function extractServingInfo(description) {
  // Default values
  let result = {
    size: 100,
    unit: 'g',
    text: null
  };
  
  // Try to extract standard "Per Xg" format first
  const gramPattern = /Per (\d+)g/;
  const gramMatch = description.match(gramPattern);
  
  if (gramMatch) {
    result.size = parseInt(gramMatch[1]);
    result.text = gramMatch[0];
    return result;
  }
  
  // Try more complex patterns like "Per 1/4 cup"
  const complexPattern = /Per ([^-]+)/;
  const complexMatch = description.match(complexPattern);
  
  if (complexMatch) {
    const servingText = complexMatch[1].trim();
    result.text = `Per ${servingText}`;
    
    // Check for standard measurements
    if (servingText.includes('cup')) {
      result.unit = 'cup';
      
      // Handle fractions like 1/4 cup
      const fractionMatch = servingText.match(/(\d+)\/(\d+)/);
      if (fractionMatch) {
        result.size = parseInt(fractionMatch[1]) / parseInt(fractionMatch[2]);
      } else {
        // Handle whole numbers like 1 cup
        const numberMatch = servingText.match(/(\d+)/);
        if (numberMatch) {
          result.size = parseInt(numberMatch[1]);
        } else {
          result.size = 1; // Default to 1 if no number found
        }
      }
    } else if (servingText.includes('oz') || servingText.includes('ounce')) {
      result.unit = 'oz';
      
      // Extract the number
      const numberMatch = servingText.match(/(\d+)/);
      if (numberMatch) {
        result.size = parseInt(numberMatch[1]);
      } else {
        result.size = 1;
      }
    } else if (servingText.includes('tbsp') || servingText.includes('tablespoon')) {
      result.unit = 'tbsp';
      
      // Extract the number
      const numberMatch = servingText.match(/(\d+)/);
      if (numberMatch) {
        result.size = parseInt(numberMatch[1]);
      } else {
        result.size = 1;
      }
    } else if (servingText.includes('piece') || servingText.includes('cookie') || servingText.includes('serving')) {
      result.unit = 'piece';
      
      // Extract the number
      const numberMatch = servingText.match(/(\d+)/);
      if (numberMatch) {
        result.size = parseInt(numberMatch[1]);
      } else {
        result.size = 1;
      }
    }
    
    return result;
  }
  
  // If no pattern matches, return default values
  return result;
}

// Helper function to transform detailed food information
function transformFoodDetails(data) {
  // Implementation would be similar to transformSingleFood but with more detailed information
  return transformSingleFood(data.food);
}

// Helper function to extract calories
function extractCalories(description) {
  const pattern = /Calories:\s*(\d+)kcal/;
  const match = description.match(pattern);
  return match ? parseInt(match[1]) : 0;
}

// Helper function to extract nutrients
function extractNutrient(description, type) {
  const pattern = new RegExp(`${type}:\\s*(\\d+\\.?\\d*)g`);
  const match = description.match(pattern);
  return match ? parseFloat(match[1]) : 0;
}

// MARK: - Product ingredient report (photo + metadata → email team for OFF correction)
app.post('/api/product-report', productReportUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: 'Image is required' });
    }

    const barcode = sanitizeBarcode(req.body?.barcode);
    if (!barcode) {
      cleanupUploadedFile(req.file.path);
      return res.status(400).json({ code: 400, message: 'Valid barcode is required (8–14 digits)' });
    }

    const rateKey = `${req.ip || 'unknown'}:${barcode}`;
    const reportCount = reportRateCache.get(rateKey) || 0;
    if (reportCount >= 3) {
      cleanupUploadedFile(req.file.path);
      return res.status(429).json({ code: 429, message: 'Too many reports for this product. Please try again later.' });
    }
    reportRateCache.set(rateKey, reportCount + 1);

    const reportId = path.basename(req.file.filename, path.extname(req.file.filename));
    const productName = (req.body?.productName || '').trim() || 'Unknown product';
    const brand = (req.body?.brand || '').trim();
    const language = (req.body?.language || '').trim() || 'en';
    const ingredientsText = (req.body?.ingredientsText || '').trim();
    const note = (req.body?.note || '').trim();
    const userId = (req.body?.userId || '').trim();

    const metadata = {
      reportId,
      barcode,
      productName,
      brand: brand || null,
      language,
      ingredientsText: ingredientsText || null,
      note: note || null,
      userId: userId || null,
      imagePath: req.file.path,
      imageFilename: req.file.filename,
      submittedAt: new Date().toISOString(),
      clientIp: req.ip || null,
    };

    const metadataPath = path.join(path.dirname(req.file.path), `${reportId}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    await sendProductReportEmail(metadata);

    console.log(`[ProductReport] Saved report ${reportId} for barcode ${barcode}`);
    res.status(200).json({ ok: true, reportId });
  } catch (error) {
    console.error('[ProductReport] Error:', error.message);
    if (req.file?.path) {
      cleanupUploadedFile(req.file.path);
    }
    res.status(500).json({ code: 500, message: error.message || 'Failed to submit product report' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ code: 400, message: 'Image must be 5 MB or smaller' });
    }
    return res.status(400).json({ code: 400, message: err.message });
  }
  if (err?.message?.includes('Invalid image type')) {
    return res.status(400).json({ code: 400, message: err.message });
  }
  next(err);
});

function sanitizeBarcode(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  return digits;
}

function cleanupUploadedFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn('[ProductReport] Failed to cleanup file:', e.message);
  }
}

async function sendProductReportEmail(metadata) {
  const to = process.env.PRODUCT_REPORT_EMAIL;
  if (!to) {
    console.warn('[ProductReport] PRODUCT_REPORT_EMAIL not set — report saved but no email sent');
    return;
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser || 'noreply@nutriswap.app';

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('[ProductReport] SMTP not configured — report saved but no email sent');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const offEditUrl = `https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=${metadata.barcode}`;
  const offProductUrl = `https://world.openfoodfacts.org/product/${metadata.barcode}`;
  const brandLine = metadata.brand ? `${metadata.brand} — ` : '';

  const textBody = [
    'New NutriSwap product ingredient report',
    '',
    `Product: ${brandLine}${metadata.productName}`,
    `Barcode: ${metadata.barcode}`,
    `Language: ${metadata.language}`,
    `Report ID: ${metadata.reportId}`,
    metadata.userId ? `User ID: ${metadata.userId}` : null,
    '',
    'Current ingredients in app (from Open Food Facts):',
    metadata.ingredientsText || '(none provided)',
    '',
    metadata.note ? `User note:\n${metadata.note}` : null,
    '',
    `Edit on Open Food Facts: ${offEditUrl}`,
    `Product page: ${offProductUrl}`,
    '',
    'Ingredient label photo is attached.',
  ].filter(Boolean).join('\n');

  await transporter.sendMail({
    from: smtpFrom,
    to,
    subject: `[NutriSwap] Product report — ${metadata.barcode} ${metadata.productName}`,
    text: textBody,
    attachments: [
      {
        filename: metadata.imageFilename,
        path: metadata.imagePath,
      },
    ],
  });
}

// MARK: - Scan AI Analysis Stream
// POST /api/scan/analysis/stream
// Accepts ScanAIInput JSON, streams an OpenAI analysis back as SSE chunks.
app.post('/api/scan/analysis/stream', async (req, res) => {
  try {
    const {
      productName, brand, score, rating,
      processingLevel, seedOils, sweeteners, additives, qualityMarkers
    } = req.body;

    if (!productName) {
      return res.status(400).json({ error: 'productName is required' });
    }

    const brandText = brand ? ` by ${brand}` : '';

    let concernLines = '';
    if (seedOils?.length)    concernLines += `\nSeed oils: ${seedOils.join(', ')}`;
    if (sweeteners?.length)  concernLines += `\nSweeteners: ${sweeteners.join(', ')}`;
    if (additives?.length)   concernLines += `\nAdditives: ${additives.join(', ')}`;

    const concernsText = concernLines.trim()
      ? `\nIngredient concerns:${concernLines}`
      : '\nNo major ingredient concerns detected.';
    const markersText = qualityMarkers?.length
      ? `\nPositive markers: ${qualityMarkers.join(', ')}`
      : '';

    const systemPrompt = `You are NutriSwap, a concise nutrition analyst. Write exactly 3-4 sentences (max 90 words) about a scanned food product. Rules:
- Always use the exact product name provided, never say "this product"
- Wrap specific concerning ingredient names in **double asterisks** for bold (e.g. **sunflower oil**, **acesulfame K**, **carrageenan**)
- Be direct and factual, not alarmist
- Mention score context briefly`;

    const userPrompt = `Product: ${productName}${brandText}
Score: ${score}/100 (${rating})
Processing level: ${processingLevel}${concernsText}${markersText}

Write the analysis for "${productName}" now.`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const openaiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
        max_tokens: 150,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'stream'
      }
    );

    openaiResponse.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
          }
        } catch (e) {
          // skip malformed chunk
        }
      }
    });

    openaiResponse.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    openaiResponse.data.on('error', (err) => {
      console.error('[ScanAnalysis] OpenAI stream error:', err.message);
      res.end();
    });

  } catch (error) {
    console.error('[ScanAnalysis] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate analysis' });
    } else {
      res.end();
    }
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});

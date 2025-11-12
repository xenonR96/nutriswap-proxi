const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

// Enable CORS for all origins
app.use(cors());
app.use(express.json());

// FatSecret API credentials
const CLIENT_ID = '8ffd10d7d66c4ac5aba9bf5b2c433e4a';
const CLIENT_SECRET = '6656b2469dbe4d8d8f8ef39c76188f62';
const AUTH_URL = 'https://oauth.fatsecret.com/connect/token';
const API_URL = 'https://platform.fatsecret.com/rest/server.api';

// Token storage (in production, use Redis or database)
let cachedToken = null;
let tokenExpiry = null;

// Get OAuth token from FatSecret
async function getAccessToken(scope = 'basic') {
  try {
    // Check if we have a valid cached token
    if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
      return cachedToken;
    }

    console.log('🔑 Requesting new FatSecret access token...');
    
    const response = await axios({
      method: 'POST',
      url: AUTH_URL,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `grant_type=client_credentials&scope=${scope}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
    });

    cachedToken = response.data.access_token;
    tokenExpiry = new Date(Date.now() + (response.data.expires_in * 1000));
    
    console.log('✅ Got new access token, expires at:', tokenExpiry);
    return cachedToken;
  } catch (error) {
    console.error('❌ Error getting access token:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function to extract nutrition data from food description
function extractCalories(description) {
  const match = description.match(/Calories:\s*(\d+)/i);
  return match ? parseInt(match[1]) : 0;
}

function extractNutrient(description, nutrientType) {
  const patterns = {
    'Protein': /Protein:\s*([\d.]+)g/i,
    'Carbs': /Carbs:\s*([\d.]+)g/i,
    'Fat': /Fat:\s*([\d.]+)g/i
  };
  
  const pattern = patterns[nutrientType];
  if (!pattern) return 0;
  
  const match = description.match(pattern);
  return match ? parseFloat(match[1]) : 0;
}

function extractServingInfo(description) {
  // Extract serving information from description
  // Example: "Per 100g - Calories: 22kcal | Fat: 0.34g | Carbs: 3.28g | Protein: 3.09g"
  const servingMatch = description.match(/Per\s+([\d.]+)\s*([a-zA-Z]+)/i);
  
  if (servingMatch) {
    return {
      size: parseFloat(servingMatch[1]),
      unit: servingMatch[2],
      text: `${servingMatch[1]} ${servingMatch[2]}`
    };
  }
  
  // Default to 100g
  return {
    size: 100,
    unit: 'g',
    text: '100 g'
  };
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

// Helper function to transform detailed food data from food.get.v2
function transformDetailedFood(foodData) {
  const { food_id, food_name, brand_name, servings } = foodData;
  
  // Get the first serving for nutrition data
  let serving = null;
  if (servings && servings.serving) {
    if (Array.isArray(servings.serving)) {
      serving = servings.serving[0];
    } else {
      serving = servings.serving;
    }
  }
  
  if (!serving) {
    throw new Error('No serving information available');
  }
  
  // Extract nutrition data
  const calories = parseInt(serving.calories) || 0;
  const protein = parseFloat(serving.protein) || 0;
  const carbs = parseFloat(serving.carbohydrate) || 0;
  const fat = parseFloat(serving.fat) || 0;
  
  // Get serving info
  const metricAmount = parseFloat(serving.metric_serving_amount) || 100;
  const metricUnit = serving.metric_serving_unit || 'g';
  const servingDescription = serving.serving_description || `${metricAmount} ${metricUnit}`;
  
  // Scale nutrition to per 100g if needed
  const scaleFactor = metricUnit.toLowerCase() === 'oz' ? 100 / (metricAmount * 28.3495) : 100 / metricAmount;
  
  return {
    id: food_id,
    name: food_name,
    description: servingDescription,
    food_type: brand_name ? 'Brand' : 'Generic',
    brand_name: brand_name || null,
    calories: Math.round(calories * scaleFactor),
    protein: Math.round((protein * scaleFactor) * 10) / 10,
    carbs: Math.round((carbs * scaleFactor) * 10) / 10,
    fat: Math.round((fat * scaleFactor) * 10) / 10,
    servingSize: metricUnit.toLowerCase() === 'oz' ? metricAmount * 28.3495 : metricAmount,
    servingUnit: metricUnit.toLowerCase() === 'oz' ? 'g' : metricUnit,
    servingText: servingDescription
  };
}

// ROUTES

// Health check endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Food search endpoint
app.get('/api/food/search', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }
    
    console.log(`🔍 Searching for: ${query}`);
    
    const token = await getAccessToken('basic');
    
    const response = await axios({
      method: 'POST',
      url: API_URL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `method=foods.search&search_expression=${encodeURIComponent(query)}&format=json&max_results=25`,
    });
    
    const data = response.data;
    console.log('📦 FatSecret response status:', response.status);
    console.log('📦 FatSecret response headers:', JSON.stringify(response.headers, null, 2));
    console.log('📦 FatSecret raw body:', JSON.stringify(data, null, 2));
    
    if (data.foods && data.foods.food) {
      const foods = Array.isArray(data.foods.food) ? data.foods.food : [data.foods.food];
      const transformedFoods = foods.map(transformSingleFood);
      
      console.log(`✅ Found ${transformedFoods.length} foods`);
      res.json(transformedFoods);
    } else {
      console.log('📭 No foods found');
      res.json([]);
    }
  } catch (error) {
    if (error.response) {
      console.error('❌ Food search error status:', error.response.status);
      console.error('❌ Food search error headers:', JSON.stringify(error.response.headers, null, 2));
      console.error('❌ Food search error body:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('❌ Food search error:', error.message);
    }
    res.status(500).json({ 
      error: 'Food search failed', 
      details: error.response?.data || error.message 
    });
  }
});

// Food details endpoint
app.get('/api/food/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🔍 Getting food details for ID: ${id}`);
    
    const token = await getAccessToken('basic');
    
    const response = await axios({
      method: 'POST',
      url: API_URL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `method=food.get.v2&food_id=${id}&format=json`,
    });
    
    const data = response.data;
    
    if (data.food) {
      const transformedFood = transformDetailedFood(data.food);
      console.log(`✅ Got detailed food: ${transformedFood.name}`);
      res.json(transformedFood);
    } else {
      console.log(`❌ Food not found for ID: ${id}`);
      res.status(404).json({ error: 'Food not found' });
    }
  } catch (error) {
    console.error('❌ Food details error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Food details lookup failed', 
      details: error.response?.data || error.message 
    });
  }
});

// Barcode lookup endpoint
app.get('/api/food/barcode/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const cleanBarcode = barcode.replace(/\D/g, ''); // Remove non-digits
    
    console.log(`🔍 Looking up barcode: ${cleanBarcode}`);
    
    const token = await getAccessToken('basic barcode');
    
    // Step 1: Get food ID from barcode
    const barcodeResponse = await axios({
      method: 'POST',
      url: API_URL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `method=food.find_id_for_barcode&barcode=${cleanBarcode}&format=json`,
    });
    
    const barcodeData = barcodeResponse.data;
    let foodId = null;
    
    // Extract food ID from response
    if (barcodeData.food_id) {
      if (typeof barcodeData.food_id === 'object' && barcodeData.food_id.value) {
        foodId = barcodeData.food_id.value;
      } else if (typeof barcodeData.food_id === 'string') {
        foodId = barcodeData.food_id;
      }
    }
    
    if (!foodId) {
      console.log(`📭 No food found for barcode: ${cleanBarcode}`);
      return res.status(404).json({ error: 'Barcode not found' });
    }
    
    console.log(`✅ Found food ID: ${foodId} for barcode: ${cleanBarcode}`);
    
    // Step 2: Get detailed food information
    const foodResponse = await axios({
      method: 'POST',
      url: API_URL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `method=food.get.v2&food_id=${foodId}&format=json`,
    });
    
    const foodData = foodResponse.data;
    
    if (foodData.food) {
      const transformedFood = transformDetailedFood(foodData.food);
      console.log(`✅ Got detailed food from barcode: ${transformedFood.name}`);
      res.json(transformedFood);
    } else {
      console.log(`❌ Food details not found for ID: ${foodId}`);
      res.status(404).json({ error: 'Food details not found' });
    }
  } catch (error) {
    console.error('❌ Barcode lookup error:', error.response?.data || error.message);
    
    // Check if it's a "not found" error
    if (error.response?.data && 
        (error.response.data.toString().includes('not found') || 
         error.response.data.toString().includes('No matches found'))) {
      res.status(404).json({ error: 'Barcode not found in database' });
    } else {
      res.status(500).json({ 
        error: 'Barcode lookup failed', 
        details: error.response?.data || error.message 
      });
    }
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FatSecret Proxy Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/status`);
  console.log(`🔍 Food search: http://localhost:${PORT}/api/food/search?query=apple`);
  console.log(`📋 Food details: http://localhost:${PORT}/api/food/123456`);
  console.log(`📦 Barcode lookup: http://localhost:${PORT}/api/food/barcode/123456789012`);
}); 

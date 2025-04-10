require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const NodeCache = require('node-cache');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Create cache instances
const tokenCache = new NodeCache({ stdTTL: parseInt(process.env.TOKEN_CACHE_TTL) || 3500 });
const foodCache = new NodeCache({ stdTTL: parseInt(process.env.FOOD_CACHE_TTL) || 86400 });

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

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
    const transformedResults = await transformFoodResults(response.data, accessToken);
    
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
async function transformFoodResults(data, accessToken) {
  try {
    const foodList = data.foods?.food || [];
    
    if (!Array.isArray(foodList)) {
      // Handle case where only one food is returned
      return [await transformSingleFood(foodList, accessToken)];
    }
    
    // Process foods in batches to avoid overwhelming the API
    const batchSize = 5;
    const results = [];
    
    for (let i = 0; i < foodList.length; i += batchSize) {
      const batch = foodList.slice(i, i + batchSize);
      const transformPromises = batch.map(food => transformSingleFood(food, accessToken));
      const transformedBatch = await Promise.all(transformPromises);
      results.push(...transformedBatch);
    }
    
    return results;
  } catch (error) {
    console.error('Error transforming food results:', error.message);
    return [];
  }
}

// Helper function to transform a single food item
async function transformSingleFood(foodItem, accessToken) {
  const { food_id, food_name, food_description } = foodItem;
  
  // Extract nutrition values from the description
  const calories = extractCalories(food_description);
  const protein = extractNutrient(food_description, 'Protein');
  const carbs = extractNutrient(food_description, 'Carbs');
  const fat = extractNutrient(food_description, 'Fat');
  
  // Extract serving size
  const servingSizeMatch = food_description.match(/Per (\d+)g/);
  const servingSize = servingSizeMatch ? parseInt(servingSizeMatch[1]) : 100;
  
  // Try to get detailed serving information if available
  let servings = [];
  try {
    // Get detailed food info to extract serving descriptions
    const detailedInfo = await getDetailedFoodInfo(food_id, accessToken);
    if (detailedInfo && detailedInfo.food && detailedInfo.food.servings) {
      servings = extractServingInfo(detailedInfo.food.servings);
    }
  } catch (error) {
    console.warn(`Could not fetch serving descriptions for ${food_name}:`, error.message);
  }
  
  return {
    id: food_id,
    name: food_name,
    calories: calories,
    protein: protein,
    carbs: carbs,
    fat: fat,
    servingSize: servingSize,
    servingUnit: 'g',
    servings: servings
  };
}

// Helper function to transform detailed food information
async function transformFoodDetails(data) {
  const foodData = data.food;
  
  // Extract basic food information
  const basicInfo = transformSingleFoodBasic(foodData);
  
  // Extract serving information
  const servings = foodData.servings ? extractServingInfo(foodData.servings) : [];
  
  // Return combined information
  return {
    ...basicInfo,
    servings: servings
  };
}

// Helper function to transform a single food item without fetching additional data
function transformSingleFoodBasic(foodItem) {
  const { food_id, food_name, food_description } = foodItem;
  
  // Extract nutrition values from the description
  const calories = extractCalories(food_description);
  const protein = extractNutrient(food_description, 'Protein');
  const carbs = extractNutrient(food_description, 'Carbs');
  const fat = extractNutrient(food_description, 'Fat');
  
  // Extract serving size
  const servingSizeMatch = food_description.match(/Per (\d+)g/);
  const servingSize = servingSizeMatch ? parseInt(servingSizeMatch[1]) : 100;
  
  return {
    id: food_id,
    name: food_name,
    calories: calories,
    protein: protein,
    carbs: carbs,
    fat: fat,
    servingSize: servingSize,
    servingUnit: 'g'
  };
}

// Helper function to extract serving information
function extractServingInfo(servingsData) {
  try {
    // Handle single serving or array of servings
    const servingsArray = Array.isArray(servingsData.serving) 
      ? servingsData.serving 
      : [servingsData.serving];
    
    return servingsArray.map(serving => {
      // Extract the gram equivalent
      let gramsEquivalent = 0;
      if (serving.metric_serving_amount) {
        gramsEquivalent = parseFloat(serving.metric_serving_amount);
      }
      
      return {
        description: serving.serving_description || '',
        gramsEquivalent: gramsEquivalent
      };
    }).filter(serving => serving.description && serving.gramsEquivalent > 0);
  } catch (error) {
    console.error('Error extracting serving information:', error.message);
    return [];
  }
}

// Helper function to get detailed food information
async function getDetailedFoodInfo(foodId, accessToken) {
  // Check cache first
  const cacheKey = `food_details_raw_${foodId}`;
  const cachedResult = foodCache.get(cacheKey);
  
  if (cachedResult) {
    console.log(`[CACHE HIT] Found cached raw details for food ID "${foodId}"`);
    return cachedResult;
  }
  
  // Construct the FatSecret API URL
  const params = new URLSearchParams({
    method: 'food.get',
    food_id: foodId,
    format: 'json',
    include_sub_categories: 'true'
  });
  
  const apiUrl = `${process.env.FATSECRET_API_URL}?${params.toString()}`;
  
  // Make the request to FatSecret API
  const response = await axios.get(apiUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  // Cache the raw response
  foodCache.set(cacheKey, response.data);
  
  return response.data;
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

// Start the server
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
}); 

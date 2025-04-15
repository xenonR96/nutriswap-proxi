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
  const { food_id, food_name, food_description } = foodItem;
  
  // Extract nutrition values from the description
  const calories = extractCalories(food_description);
  const protein = extractNutrient(food_description, 'Protein');
  const carbs = extractNutrient(food_description, 'Carbs');
  const fat = extractNutrient(food_description, 'Fat');
  
  // Extract serving size with improved pattern matching
  const servingInfo = extractServingInfo(food_description);
  
  return {
    id: food_id,
    name: food_name,
    description: food_description,
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

// Start the server
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
}); 

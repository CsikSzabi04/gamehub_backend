import fetch from 'node-fetch';

/**
 * Safe API request with error handling and timeout
 */
export async function fetchAPI(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      timeout
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - API took too long to respond');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Standardized error response
 */
export function errorResponse(error, defaultMessage = 'An error occurred') {
  const isProduction = process.env.NODE_ENV === 'production';
  
  return {
    success: false,
    error: {
      message: isProduction ? defaultMessage : error.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
    }
  };
}

/**
 * Standardized success response
 */
export function successResponse(data) {
  return {
    success: true,
    data
  };
}

/**
 * Input validation helper
 */
export function validateInput(data, schema) {
  for (const [key, validator] of Object.entries(schema)) {
    if (validator.required && !data[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
    if (data[key] && validator.type && typeof data[key] !== validator.type) {
      throw new Error(`Invalid type for ${key}: expected ${validator.type}`);
    }
  }
  return true;
}

/**
 * Array index finder (optimized)
 */
export function findIndex(array, predicate) {
  return array.findIndex(predicate);
}

/**
 * Safe JSON parse
 */
export function safeJsonParse(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('JSON parse error:', error);
    return defaultValue;
  }
}

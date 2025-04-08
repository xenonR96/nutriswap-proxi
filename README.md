# NutriSwap API Proxy Server

This is a proxy server for the NutriSwap AI mobile application that handles secure API communication with FatSecret. The proxy server is responsible for:

1. Managing OAuth 2.0 token authentication with FatSecret
2. Forwarding API requests to FatSecret
3. Caching results to improve performance
4. Protecting API credentials from exposure in the mobile app

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm (v7 or higher)

### Installation

1. Clone this repository
2. Navigate to the server directory:
   ```
   cd /path/to/ProxyServer
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. Configure environment variables:
   - Rename `.env.example` to `.env` (or create a new `.env` file)
   - Update the values in the `.env` file with your FatSecret API credentials

### Running the Server

For development:
```
npm run dev
```

For production:
```
npm start
```

The server will start on port 3000 by default (or the port specified in your environment variables).

## API Endpoints

### Health Check
```
GET /api/status
```
Returns the status of the server.

### Search Foods
```
GET /api/food/search?query=apple
```
Searches for foods matching the provided query.

### Get Food Details
```
GET /api/food/:id
```
Gets detailed information about a specific food item.

## Configuration

The following environment variables can be configured in the `.env` file:

- `PORT`: The port on which the server will run (default: 3000)
- `NODE_ENV`: The environment mode (development or production)
- `FATSECRET_CLIENT_ID`: Your FatSecret API client ID
- `FATSECRET_CLIENT_SECRET`: Your FatSecret API client secret
- `FATSECRET_TOKEN_URL`: The OAuth token endpoint URL
- `FATSECRET_API_URL`: The FatSecret API base URL
- `TOKEN_CACHE_TTL`: Time-to-live for token cache in seconds
- `FOOD_CACHE_TTL`: Time-to-live for food search cache in seconds

## Security Considerations

- Keep your `.env` file secure and never commit it to version control
- In production, use HTTPS to secure the communication between the mobile app and the proxy server
- Consider adding rate limiting and request validation for additional security

## Deployment

This server can be deployed to various cloud platforms:

- Heroku
- AWS Elastic Beanstalk
- Google Cloud App Engine
- Azure App Service

For production deployment, make sure to:
1. Use appropriate environment variables for the production environment
2. Enable HTTPS
3. Set up monitoring and logging
4. Configure proper error handling and notifications 
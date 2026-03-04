# Postal Delivery System

A full-stack postal delivery management system for tracking packages, managing deliveries, and processing payments.

## Features

### User Features
- **User Authentication**: Secure login and registration system
- **Package Tracking**: Track packages with unique tracking numbers
- **Delivery Management**: View delivery dates, amounts, and status
- **Payment Processing**: Pay for deliveries with various payment methods
- **Personal Dashboard**: Overview of packages, deliveries, and payments
- **Monthly Reports**: Detailed breakdown of deliveries by month

### Admin Features
- **User Management**: Create, update, and delete user accounts
- **Delivery Service Management**: Manage delivery service types (Express, Standard, International)
- **Package Management**: Create and track packages for users
- **Delivery Creation**: Generate deliveries with due dates and amounts
- **Payment Tracking**: Monitor all payment transactions
- **Admin Dashboard**: Comprehensive overview of system metrics
- **Shipping Invoices**: Print-ready invoices for deliveries

## Technology Stack

- **Backend**: Node.js, Express.js
- **Database**: SQLite3
- **Frontend**: EJS (Embedded JavaScript Templates)
- **HTTP Client**: Axios
- **Styling**: Custom CSS with dark/light theme support

## Database Schema

### Tables

1. **users**: User accounts with role-based access (admin/user)
2. **delivery_services**: Types of delivery services available
3. **packages**: Package records with tracking numbers
4. **deliveries**: Delivery records with dates, amounts, and status
5. **payments**: Payment transactions for deliveries

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd Postal_Deliverly_System-FS-PROJECT
```

2. Install dependencies:
```bash
npm install
```

3. The database will be created automatically on first run.

## Running the Application

### Development Mode (Both servers)
Run both backend and frontend servers concurrently:
```bash
npm run dev
```

### Backend Only (API Server)
```bash
npm run backend
```
The API server runs on http://localhost:4000

### Frontend Only (Web Interface)
```bash
npm run frontend
```
The web interface runs on http://localhost:5500

### Production Mode
```bash
npm start
```

## Default Accounts

### Administrator Account
- **Email**: admin@postal.local
- **Password**: admin123
- **Role**: Admin

### User Account
- **Email**: user@postal.local
- **Password**: user123
- **Role**: User

## Project Structure

```
Postal_Deliverly_System-FS-PROJECT/
├── Database/
│   └── postal_delivery.db         # SQLite database (auto-generated)
├── public/
│   ├── css/
│   │   └── style.css              # Main stylesheet
│   ├── images/
│   │   └── flower-logo.svg        # Logo image
│   └── views/
│       ├── partials/
│       │   ├── layout-top.ejs     # Header partial
│       │   └── layout-bottom.ejs  # Footer partial
│       ├── index.ejs              # Home dashboard
│       ├── login.ejs              # Login page
│       ├── register.ejs           # Registration page
│       ├── access-denied.ejs      # Access denied page
│       ├── admin-dashboard.ejs    # Admin dashboard
│       ├── user-dashboard.ejs     # User dashboard
│       ├── users.ejs              # User list (admin)
│       ├── create.ejs             # Create user (admin)
│       ├── update.ejs             # Update user (admin)
│       ├── user.ejs               # User detail page (admin)
│       ├── user-invoices.ejs      # User invoices (admin)
│       ├── delivery-services.ejs  # Delivery services list (admin)
│       ├── create-delivery-service.ejs # Create delivery service (admin)
│       ├── packages.ejs           # Package list (admin)
│       ├── create-package.ejs     # Create package (admin)
│       ├── deliveries.ejs         # Deliveries list
│       ├── create-delivery.ejs    # Create delivery (admin)
│       ├── invoice.ejs            # Shipping invoice
│       ├── payments.ejs           # Payments list
│       └── pay-delivery.ejs       # Payment page
├── .gitignore                     # Git ignore file
├── AxiousHtml.js                  # Frontend server
├── package.json                   # Node.js dependencies
├── README.md                      # This file
└── SQliteDB.js                    # Backend API server

```

## API Endpoints

### Authentication
- `POST /auth/login` - Authenticate user

### Users
- `GET /users` - List all users
- `GET /users/:id` - Get user by ID
- `POST /users` - Create new user
- `PUT /users/:id` - Update user
- `DELETE /users/:id` - Delete user

### Delivery Services
- `GET /delivery-services` - List all delivery services
- `POST /delivery-services` - Create delivery service
- `DELETE /delivery-services/:id` - Delete delivery service

### Packages
- `GET /packages` - List all packages
- `POST /packages` - Create package
- `DELETE /packages/:id` - Delete package

### Deliveries
- `GET /deliveries` - List all deliveries
- `GET /deliveries/:id` - Get delivery by ID
- `POST /deliveries` - Create delivery
- `DELETE /deliveries/:id` - Delete delivery

### Payments
- `GET /payments` - List all payments
- `POST /payments` - Create payment and mark delivery as paid
- `DELETE /payments/:id` - Delete payment

## Features Explained

### Role-Based Access Control
- **Admin**: Full access to all features including user management, delivery service management, package creation, and delivery creation
- **User**: Can view their own packages, deliveries, and payments; can make payments
- **Guest**: Can only access login and registration pages

### Package Tracking
Each package has a unique tracking number that can be used to:
- Identify the package
- Track delivery status
- Associate deliveries with the package
- View payment history

### Delivery Management
Deliveries have the following properties:
- **Delivery Date**: When the delivery occurred
- **Amount**: Cost of the delivery
- **Due Date**: Payment deadline
- **Status**: paid, unpaid, or overdue

### Payment Processing
Users can pay for deliveries using various payment methods:
- Credit Card
- Bank Transfer
- Cash
- Custom methods

Payments are linked to deliveries and automatically update delivery status to "paid".

### Monthly Reports
The system generates monthly reports showing:
- Total deliveries per month
- Paid vs unpaid deliveries
- Outstanding amounts
- Collection rates
- Delivery date ranges

### Dark/Light Theme
The interface supports both dark and light themes:
- Automatically detects system preference
- Manual toggle available
- Preference saved in browser localStorage

## Security Features

- Password-based authentication
- Role-based authorization
- HTTP-only auth cookies
- CSRF protection via SameSite cookies
- Session timeout (30 days)
- SQL injection prevention via parameterized queries
- Foreign key constraints
- Input validation and sanitization

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Responsive design for mobile and tablet devices
- Print-optimized layouts for invoices and reports

## Development

### Adding Delivery Services
1. Login as admin
2. Navigate to "Delivery Services"
3. Click "Create Delivery Service"
4. Enter service name (e.g., "Express", "Standard", "International")

### Creating Packages
1. Login as admin
2. Navigate to "Packages"
3. Click "Create Package"
4. Enter tracking number, select user and delivery service

### Creating Deliveries
1. Login as admin
2. Navigate to "Deliveries"
3. Click "Create Delivery"
4. Select package, enter delivery date, amount, and due date

### Processing Payments
1. User navigates to "Deliveries"
2. Click "Pay" on an unpaid delivery
3. Enter payment method and optional transaction reference
4. Submit payment

## Troubleshooting

### Backend API is offline
If you see "Backend API is offline" errors:
1. Make sure the backend is running: `npm run backend`
2. Check that port 4000 is available
3. Verify the API URL in AxiousHtml.js (default: http://localhost:4000)

### Port already in use
If port 4000 or 5500 is already in use:
1. Stop the existing process
2. Or modify the PORT in the respective files:
   - Backend: Change PORT in SQliteDB.js
   - Frontend: Change port in AxiousHtml.js

### Database issues
If database errors occur:
1. Delete the Database/postal_delivery.db file
2. Restart the backend server
3. Database will be recreated with default accounts

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions, please open an issue on the GitHub repository.

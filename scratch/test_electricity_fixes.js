const electricityController = require('../controllers/electricityController');
const electricityRoutes = require('../routes/electricityRoutes');
const tenantDuesService = require('../services/tenantDuesService');

console.log('✅ All electricity modules loaded successfully.');
console.log('  - updateMeterReading:', typeof electricityController.updateMeterReading);
console.log('  - bulkUpdateReadings:', typeof electricityController.bulkUpdateReadings);
console.log('  - getOwnerReadings:', typeof electricityController.getOwnerReadings);
console.log('  - deleteMeterReading:', typeof electricityController.deleteMeterReading);
console.log('  - syncElectricityToInvoice:', typeof tenantDuesService.syncElectricityToInvoice);

# 1. USER & ACCESS DOMAIN

customer_id (PK): The surrogate key. Decouples identity from changeable data.
license_number (UNIQUE): The legal anchor. Ensures a banned driver cannot rent again.
is_blacklisted: A hard boolean stop at the database level.

# 2. CATALOG & PRICING DOMAIN

passenger_capacity, baggage_capacity live on the category, not the vehicle.
This is 3NF abstraction: it avoids repeating "5 passengers" across every car.

# 3. NORMALISATION

Third normal form removes transitive dependencies so one fact lives in one place.
Denormalisation is the deliberate reverse, used for read performance.

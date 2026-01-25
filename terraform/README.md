# Plus2 AWS Infrastructure

Terraform configuration for deploying the Plus2 API backend to AWS.

## Architecture

- **ECS Fargate** - Serverless container hosting (uses Spot instances by default for ~70% cost savings)
- **Application Load Balancer** - HTTP/HTTPS load balancer with WebSocket support
- **RDS PostgreSQL** - Managed database (db.t4g.micro for cost savings)
- **ECR** - Container registry for Docker images
- **VPC** - Isolated network with public/private subnets

## Estimated Costs (dev environment)

| Resource | Monthly Cost |
|----------|-------------|
| RDS db.t4g.micro | ~$12 |
| NAT Gateway | ~$32 |
| ALB | ~$16 |
| Fargate Spot (256 CPU, 512 MB) | ~$3-5 |
| ECR | ~$1 |
| **Total** | **~$65/month** |

> **Note:** NAT Gateway is the biggest cost. For even cheaper dev environments, you could use a NAT instance or put ECS in public subnets.

## Prerequisites

1. AWS CLI configured with appropriate credentials
2. Terraform >= 1.0 installed
3. Docker installed (for building/pushing images)

## Setup

1. **Copy the example variables file:**
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   ```

2. **Edit `terraform.tfvars` with your values:**
   ```hcl
   db_password = "your-secure-password"
   jwt_secret  = "your-jwt-secret"
   ```

3. **Initialize Terraform:**
   ```bash
   terraform init
   ```

4. **Review the plan:**
   ```bash
   terraform plan
   ```

5. **Apply the infrastructure:**
   ```bash
   terraform apply
   ```

6. **Deploy the API:**
   ```bash
   ./deploy.sh
   ```

## Outputs

After applying, Terraform will output:

- `api_url` - The URL to access your API
- `ecr_repository_url` - ECR repository for pushing images
- `rds_endpoint` - Database connection string
- `deploy_commands` - Commands to deploy new images

## Deployment

Use the deploy script for easy deployments:

```bash
./deploy.sh
```

Or manually:

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ecr-url>

# Build from project root
docker build -t <ecr-url>:latest -f apps/api/Dockerfile .

# Push
docker push <ecr-url>:latest

# Deploy
aws ecs update-service --cluster plus2-dev-cluster --service plus2-dev-api --force-new-deployment
```

## Environment Variables

The ECS task is configured with these environment variables:

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | production/development |
| `PORT` | 3001 |
| `DB_HOST` | RDS endpoint |
| `DB_PORT` | 5432 |
| `DB_NAME` | plus2 |
| `DB_USERNAME` | Database username |
| `DB_PASSWORD` | Database password |
| `JWT_SECRET` | JWT signing secret |

## Cleanup

To destroy all resources:

```bash
terraform destroy
```

> **Warning:** This will delete the database and all data!

## Production Considerations

For production, consider:

1. Enable `deletion_protection` on RDS
2. Use `multi_az = true` for RDS
3. Add HTTPS with ACM certificate
4. Enable Container Insights
5. Set up autoscaling for ECS
6. Use Secrets Manager for sensitive values
7. Set up CloudWatch alarms

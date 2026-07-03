#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Check if terraform outputs exist
if ! terraform -chdir="$SCRIPT_DIR" output ecr_repository_url &> /dev/null; then
    echo -e "${RED}Error: Terraform not initialized or infrastructure not deployed.${NC}"
    echo "Run 'terraform init && terraform apply' first."
    exit 1
fi

# Get values from terraform output
ECR_URL=$(terraform -chdir="$SCRIPT_DIR" output -raw ecr_repository_url)
CLUSTER_NAME=$(terraform -chdir="$SCRIPT_DIR" output -raw ecs_cluster_name)
SERVICE_NAME=$(terraform -chdir="$SCRIPT_DIR" output -raw ecs_service_name)
REGION=$(terraform -chdir="$SCRIPT_DIR" output -raw aws_region 2>/dev/null || echo "us-east-1")

echo -e "${YELLOW}Deploying to:${NC}"
echo "  ECR: $ECR_URL"
echo "  Cluster: $CLUSTER_NAME"
echo "  Service: $SERVICE_NAME"
echo ""

# Login to ECR
echo -e "${YELLOW}Logging in to ECR...${NC}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URL"

# Build the image from project root
echo -e "${YELLOW}Building Docker image...${NC}"
docker build -t "$ECR_URL:latest" -f "$PROJECT_ROOT/apps/api/Dockerfile" "$PROJECT_ROOT"

# Also tag with the git SHA so every deploy is pinnable/rollbackable
# (rollback: docker pull $ECR_URL:<sha>, tag it :latest, push, redeploy).
GIT_SHA=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
if [ "$GIT_SHA" != "unknown" ]; then
    docker tag "$ECR_URL:latest" "$ECR_URL:$GIT_SHA"
fi

# Push to ECR
echo -e "${YELLOW}Pushing to ECR...${NC}"
docker push "$ECR_URL:latest"
if [ "$GIT_SHA" != "unknown" ]; then
    docker push "$ECR_URL:$GIT_SHA"
fi

# Force new deployment
echo -e "${YELLOW}Deploying to ECS...${NC}"
aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service "$SERVICE_NAME" \
    --force-new-deployment \
    --region "$REGION" \
    --no-cli-pager

echo -e "${GREEN}Deployment initiated!${NC}"
echo ""
echo "Monitor deployment with:"
echo "  aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $REGION"

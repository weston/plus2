# ACM Certificate for API
resource "aws_acm_certificate" "api" {
  domain_name       = "api.plus2.me"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-api-cert"
  }
}

# Wait for certificate validation
resource "aws_acm_certificate_validation" "api" {
  certificate_arn = aws_acm_certificate.api.arn

  timeouts {
    create = "5m"
  }
}

# Output the DNS validation records
output "acm_validation_records" {
  description = "DNS records to add for certificate validation"
  value = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}

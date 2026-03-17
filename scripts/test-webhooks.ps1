$ErrorActionPreference = "Stop"

function PostJson($url, $obj) {
  $body = ($obj | ConvertTo-Json -Depth 20)
  Write-Host "`nPOST $url"
  Write-Host $body
  try {
    Invoke-WebRequest -Method Post -Uri $url -ContentType "application/json" -Body $body | Out-Null
    Write-Host "OK"
  } catch {
    Write-Host "FAILED: $($_.Exception.Message)"
  }
}

$port = if ($env:PORT) { $env:PORT } else { "3000" }
$base = "http://localhost:$port"

# WhatsApp Cloud API sample
PostJson "$base/api/whatsapp/webhook" @{
  entry = @(@{
    changes = @(@{
      value = @{
        contacts = @(@{ profile = @{ name = "Test WhatsApp" } })
        messages = @(@{ from = "31600000000"; type = "text"; text = @{ body = "Hallo, ik wil een afspraak maken" } })
      }
    })
  })
}

# Facebook Messenger sample
PostJson "$base/api/facebook/webhook" @{
  entry = @(@{
    messaging = @(@{
      sender = @{ id = "fb_user_123" }
      message = @{ text = "Hi, can I book an appointment?" }
    })
  })
}

# Instagram sample
PostJson "$base/api/instagram/webhook" @{
  entry = @(@{
    messaging = @(@{
      sender = @{ id = "ig_user_123" }
      message = @{ text = "Hoi! Wat kost een APK?" }
    })
  })
}

# Telnyx SMS sample
PostJson "$base/api/sms/inbound" @{
  data = @{
    event_type = "message.received"
    payload = @{
      from = @{ phone_number = "+31600000001" }
      text = "Ik wil graag gebeld worden"
    }
  }
}

Write-Host "`nDone. (Email and Voice require provider-specific webhook formats.)"


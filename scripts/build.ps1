# Check Node.js version
$requiredNodeVersion = 22
$currentNodeVersion = (node -v) -replace 'v', '' -split '\.' | Select-Object -First 1

if ($currentNodeVersion -lt $requiredNodeVersion) {
    Write-Host "Error: Node.js version must be $requiredNodeVersion or higher. Current version is $currentNodeVersion."
    exit 1
}

# Navigate to the script's directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = "$scriptDir\.."
Set-Location -Path $projectRoot

# Check if the packages directory exists
if (-not (Test-Path "packages")) {
    Write-Host "Error: 'packages' directory not found."
    exit 1
}

# Define packages to build in order
$packages = @(
    "core",
    "adapter-postgres",
    "adapter-sqlite",
    "adapter-sqljs",
    "adapter-supabase",
    "plugin-node",
    "plugin-trustdb",
    "plugin-solana",
    "plugin-starknet",
    "plugin-conflux",
    "plugin-0g",
    "plugin-bootstrap",
    "plugin-image-generation",
    "plugin-coinbase",
    "client-auto",
    "client-direct",
    "client-discord",
    "client-telegram",
    "client-twitter",
    "client-twitter-api"
)

# Build packages in specified order
foreach ($package in $packages) {
    $packagePath = "packages\$package"

    if (-not (Test-Path $packagePath)) {
        Write-Host "Package directory '$package' not found, skipping..."
        continue
    }

    Write-Host "Building package: $package"
    Set-Location -Path $packagePath

    if (Test-Path "package.json") {
        try {
            npm run build
            Write-Host "Successfully built $package`n" -ForegroundColor Green
        }
        catch {
            Write-Host "Failed to build $package" -ForegroundColor Red
            exit 1
        }
    }
    else {
        Write-Host "No package.json found in $package, skipping..."
    }

    # Return to the project root after each package build
    Set-Location -Path $projectRoot
}

Write-Host "Build process completed. 😎"

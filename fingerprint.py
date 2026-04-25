import hashlib
import json
import base64
import random

def generate_window_archi():
    """Generates a realistic window.archi by mimicking WebGPU navigator.gpu.requestAdapter() hashing."""
    gpu_data = {
        "features": [
            "depth-clip-control",
            "depth32float-stencil8",
            "texture-compression-bc",
            "timestamp-query",
            "indirect-first-instance",
            "shader-f16",
            "rg11b10ufloat-renderable",
            "bgra8unorm-storage"
        ],
        "limits": {
            "maxTextureDimension1D": 16384,
            "maxTextureDimension2D": 16384,
            "maxTextureDimension3D": 2048,
            "maxTextureArrayLayers": 2048,
            "maxBindGroups": 4,
            "maxBindGroupsPlusVertexBuffers": 24,
            "maxBindingsPerBindGroup": 1000,
            "maxDynamicUniformBuffersPerPipelineLayout": 8,
            "maxDynamicStorageBuffersPerPipelineLayout": 4,
            "maxSampledTexturesPerShaderStage": 16,
            "maxSamplersPerShaderStage": 16,
            "maxStorageBuffersPerShaderStage": 8,
            "maxStorageTexturesPerShaderStage": 4,
            "maxUniformBuffersPerShaderStage": 12,
            "maxUniformBufferBindingSize": 65536,
            "maxStorageBufferBindingSize": 2147483647,
            "minUniformBufferOffsetAlignment": 256,
            "minStorageBufferOffsetAlignment": 256,
            "maxVertexBuffers": 8,
            "maxBufferSize": 2147483647,
            "maxVertexAttributes": 16,
            "maxVertexBufferArrayStride": 2048,
            "maxInterStageShaderComponents": 64,
            "maxInterStageShaderVariables": 16,
            "maxColorAttachments": 8,
            "maxColorAttachmentBytesPerSample": 32,
            "maxComputeWorkgroupStorageSize": 16384,
            "maxComputeInvocationsPerWorkgroup": 256,
            "maxComputeWorkgroupSizeX": 256,
            "maxComputeWorkgroupSizeY": 256,
            "maxComputeWorkgroupSizeZ": 64,
            "maxComputeWorkgroupsPerDimension": 65535
        },
        "info": {
            "vendor": "nvidia",
            "architecture": "ampere",
            "device": "GeForce RTX 3060",
            "description": "NVIDIA GeForce RTX 3060"
        }
    }
    
    # Randomize a few values slightly to ensure unique fingerprint if needed,
    # or keep it static to perfectly emulate one specific GPU model.
    
    gpu_str = json.dumps(gpu_data, separators=(',', ':'), sort_keys=True)
    full_hash = hashlib.sha256(gpu_str.encode('utf-8')).hexdigest()
    
    # We'll use the first 5 characters as a proxy for the 'window.archi' hash
    # In browser it's usually "8oNm2", which is 5 chars.
    # So we take the base64 of the hash and slice 5 chars.
    b64 = base64.urlsafe_b64encode(full_hash[:10].encode('utf-8')).decode('utf-8')
    return b64[:5]

def generate_web_agent(user_id: str, salt: str, archi: str, internal_id: str) -> str:
    """Generates the SHA256 web-agent payload expected by Nekto."""
    raw_str = f"{user_id}{salt}{archi}{internal_id}"
    return hashlib.sha256(raw_str.encode('utf-8')).hexdigest()

if __name__ == "__main__":
    archi = generate_window_archi()
    print("Generated window.archi:", archi)
    print("Generated web-agent:", generate_web_agent("fake-user-id", "BYdKPTYYGZ7ALwA", archi, ""))

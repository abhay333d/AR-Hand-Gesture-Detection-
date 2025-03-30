const THREE = window.MINDAR.IMAGE.THREE;

// Constants
const DETECTION_INTERVAL = 100; // ms between detections
const MIN_DETECTION_CONFIDENCE = 0.5; // Lowered from 0.7 to make detection more sensitive

// Initialize TensorFlow.js
const initTF = async () => {
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    console.log('TensorFlow.js initialized with WebGL backend');
  } catch (error) {
    console.error('Failed to initialize TensorFlow.js:', error);
    throw error;
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  let mindarThree = null;
  let model = null;
  let animationFrameId = null;
  let detectFrameId = null;
  let isInitialized = false;

  // Loading state management
  const setLoadingState = (isLoading) => {
    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) {
      loadingIndicator.style.display = isLoading ? 'block' : 'none';
    }
  };

  const updateTrackingStatus = (status) => {
    const statusElement = document.getElementById('tracking-status');
    if (statusElement) {
      statusElement.textContent = status;
    }
  };

  const cleanup = () => {
    try {
      // Cancel animation frames first
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (detectFrameId) {
        cancelAnimationFrame(detectFrameId);
        detectFrameId = null;
      }

      // Cleanup MindAR
      if (mindarThree) {
        try {
          if (typeof mindarThree.stop === 'function') {
            mindarThree.stop();
          }
          mindarThree = null;
        } catch (error) {
          console.error('Error stopping MindAR:', error);
        }
      }

      // Cleanup model
      if (model) {
        try {
          if (typeof model.dispose === 'function') {
            model.dispose();
          }
          model = null;
        } catch (error) {
          console.error('Error disposing model:', error);
        }
      }

      isInitialized = false;
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  };

  const showError = (message) => {
    const errorMessage = document.createElement('div');
    errorMessage.style.color = 'red';
    errorMessage.style.padding = '20px';
    errorMessage.style.position = 'fixed';
    errorMessage.style.top = '50%';
    errorMessage.style.left = '50%';
    errorMessage.style.transform = 'translate(-50%, -50%)';
    errorMessage.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
    errorMessage.style.borderRadius = '5px';
    errorMessage.style.zIndex = '1000';
    errorMessage.textContent = message;
    document.body.appendChild(errorMessage);
  };

  const initializeAR = async () => {
    try {
      setLoadingState(true);
      
      // Initialize TensorFlow.js first
      await initTF();
      
      // Cleanup any existing instances first
      cleanup();
      
      // Initialize MindAR
      try {
        mindarThree = new window.MINDAR.IMAGE.MindARThree({
          container: document.body,
          imageTargetSrc: './targets/course-banner.mind',
        });

        if (!mindarThree) {
          throw new Error('MindAR instance is null');
        }

        // Get renderer, scene, and camera
        const {renderer, scene, camera} = mindarThree;

        // Create AR elements with better performance
        const geometry = new THREE.PlaneGeometry(1, 1);
        const materials = {
          default: new THREE.MeshBasicMaterial({color: 0x00ffff, transparent: true, opacity: 0.8}),
          detected: new THREE.MeshBasicMaterial({color: 0xff0000, transparent: true, opacity: 0.8})
        };

        const planes = {
          default: new THREE.Mesh(geometry, materials.default),
          detected: new THREE.Mesh(geometry, materials.detected)
        };

        // Make planes larger
        planes.default.scale.set(2, 2, 1);
        planes.detected.scale.set(2, 2, 1);

        // Initially hide the detected plane
        planes.detected.visible = false;

        // Create a container group for the planes
        const planeContainer = new THREE.Group();
        planeContainer.add(planes.default);
        planeContainer.add(planes.detected);

        // Position the container slightly in front of the target
        planeContainer.position.z = 0.1;

        // Create anchor and add the container
        const anchor = mindarThree.addAnchor(0);
        anchor.group.add(planeContainer);

        // Add tracking event listeners
        anchor.onTargetFound = () => {
          updateTrackingStatus('Target found! Show your hand to the camera');
          console.log('Target found');
        };
        anchor.onTargetLost = () => {
          updateTrackingStatus('Target lost. Point your camera at the target image');
          console.log('Target lost');
        };

        // Optimized hand detection with confidence threshold
        let lastDetectionTime = 0;
        let lastDetectionState = false;

        const detect = async () => {
          const currentTime = performance.now();
          
          if (currentTime - lastDetectionTime >= DETECTION_INTERVAL) {
            try {
              if (!model || !mindarThree || !mindarThree.video) {
                throw new Error('Required components not initialized');
              }

              const predictions = await model.estimateHands(mindarThree.video, {
                flipHorizontal: true,
                maxHands: 1,
                returnTensors: false
              });
              
              const detected = predictions.some(pred => pred.score > MIN_DETECTION_CONFIDENCE);
              
              // Only update visibility if state changed
              if (detected !== lastDetectionState) {
                planes.detected.visible = detected;
                planes.default.visible = !detected;
                lastDetectionState = detected;
                updateTrackingStatus(detected ? 'Hand detected!' : 'Show your hand to the camera');
              }
            } catch (error) {
              console.error('Hand detection error:', error);
              // Only attempt recovery if not already initialized
              if (!isInitialized) {
                cleanup();
                await initializeAR();
              }
            }
            lastDetectionTime = currentTime;
          }

          detectFrameId = window.requestAnimationFrame(detect);
        };

        // Setup handpose model with error handling and retry logic
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            model = await handpose.load({
              maxHands: 1,
              modelComplexity: 0,
              minDetectionConfidence: 0.5,
              minTrackingConfidence: 0.5
            });
            if (!model) {
              throw new Error('Model loaded but is undefined');
            }
            break;
          } catch (error) {
            retryCount++;
            if (retryCount === maxRetries) {
              throw new Error(`Failed to load handpose model after ${maxRetries} attempts: ${error?.message || 'Unknown error'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        // Start MindAR after all setup is complete
        await mindarThree.start();

        // Optimized render loop with frame rate limiting
        let lastRenderTime = 0;
        const targetFPS = 60;
        const frameInterval = 1000 / targetFPS;

        const render = (timestamp) => {
          if (timestamp - lastRenderTime >= frameInterval) {
            renderer.render(scene, camera);
            lastRenderTime = timestamp;
          }
          animationFrameId = window.requestAnimationFrame(render);
        };
        render();

        detect();
        isInitialized = true;
        setLoadingState(false);

      } catch (error) {
        throw new Error(`Failed to initialize MindAR: ${error?.message || 'Unknown error'}`);
      }

    } catch (error) {
      console.error('Failed to initialize AR:', error);
      setLoadingState(false);
      
      // Show error to user with safe error message access
      const errorMessage = error?.message || 'Unknown error occurred during AR initialization';
      showError(`Failed to initialize AR: ${errorMessage}`);

      // Cleanup after showing error
      cleanup();
    }
  };

  // Add cleanup on page unload
  window.addEventListener('beforeunload', cleanup);

  // Start initialization
  initializeAR();
});

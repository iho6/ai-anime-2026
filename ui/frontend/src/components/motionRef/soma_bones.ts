/**
 * SOMA 77-joint skeleton constants.
 *
 * Derived from kimodo/skeleton/definitions.py::SOMASkeleton77.bone_order_names_with_parents
 * Joint index = position in SOMA_JOINT_NAMES array.
 *
 * These are shared with the backend matplotlib renderer so both produce
 * identical skeleton drawings.
 */

export const SOMA_JOINT_NAMES: string[] = [
  "Hips",             // 0
  "Spine1",           // 1
  "Spine2",           // 2
  "Chest",            // 3
  "Neck1",            // 4
  "Neck2",            // 5
  "Head",             // 6
  "HeadEnd",          // 7
  "Jaw",              // 8
  "LeftEye",          // 9
  "RightEye",         // 10
  "LeftShoulder",     // 11
  "LeftArm",          // 12
  "LeftForeArm",      // 13
  "LeftHand",         // 14
  "LeftHandThumb1",   // 15
  "LeftHandThumb2",   // 16
  "LeftHandThumb3",   // 17
  "LeftHandThumbEnd", // 18
  "LeftHandIndex1",   // 19
  "LeftHandIndex2",   // 20
  "LeftHandIndex3",   // 21
  "LeftHandIndex4",   // 22
  "LeftHandIndexEnd", // 23
  "LeftHandMiddle1",  // 24
  "LeftHandMiddle2",  // 25
  "LeftHandMiddle3",  // 26
  "LeftHandMiddle4",  // 27
  "LeftHandMiddleEnd",// 28
  "LeftHandRing1",    // 29
  "LeftHandRing2",    // 30
  "LeftHandRing3",    // 31
  "LeftHandRing4",    // 32
  "LeftHandRingEnd",  // 33
  "LeftHandPinky1",   // 34
  "LeftHandPinky2",   // 35
  "LeftHandPinky3",   // 36
  "LeftHandPinky4",   // 37
  "LeftHandPinkyEnd", // 38
  "RightShoulder",    // 39
  "RightArm",         // 40
  "RightForeArm",     // 41
  "RightHand",        // 42
  "RightHandThumb1",  // 43
  "RightHandThumb2",  // 44
  "RightHandThumb3",  // 45
  "RightHandThumbEnd",// 46
  "RightHandIndex1",  // 47
  "RightHandIndex2",  // 48
  "RightHandIndex3",  // 49
  "RightHandIndex4",  // 50
  "RightHandIndexEnd",// 51
  "RightHandMiddle1", // 52
  "RightHandMiddle2", // 53
  "RightHandMiddle3", // 54
  "RightHandMiddle4", // 55
  "RightHandMiddleEnd",//56
  "RightHandRing1",   // 57
  "RightHandRing2",   // 58
  "RightHandRing3",   // 59
  "RightHandRing4",   // 60
  "RightHandRingEnd", // 61
  "RightHandPinky1",  // 62
  "RightHandPinky2",  // 63
  "RightHandPinky3",  // 64
  "RightHandPinky4",  // 65
  "RightHandPinkyEnd",// 66
  "LeftLeg",          // 67
  "LeftShin",         // 68
  "LeftFoot",         // 69
  "LeftToeBase",      // 70
  "LeftToeEnd",       // 71
  "RightLeg",         // 72
  "RightShin",        // 73
  "RightFoot",        // 74
  "RightToeBase",     // 75
  "RightToeEnd",      // 76
];

/**
 * Bone pairs as [child_index, parent_index].
 * Used to draw lines between joints in the Three.js skeleton viewer.
 */
export const SOMA_BONES: [number, number][] = [
  // Spine + neck + head
  [1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6],
  [8, 6], [9, 6], [10, 6],        // jaw, eyes
  // Left arm
  [11, 3], [12, 11], [13, 12], [14, 13],
  [15, 14], [16, 15], [17, 16], [18, 17],               // L thumb
  [19, 14], [20, 19], [21, 20], [22, 21], [23, 22],     // L index
  [24, 14], [25, 24], [26, 25], [27, 26], [28, 27],     // L middle
  [29, 14], [30, 29], [31, 30], [32, 31], [33, 32],     // L ring
  [34, 14], [35, 34], [36, 35], [37, 36], [38, 37],     // L pinky
  // Right arm
  [39, 3], [40, 39], [41, 40], [42, 41],
  [43, 42], [44, 43], [45, 44], [46, 45],               // R thumb
  [47, 42], [48, 47], [49, 48], [50, 49], [51, 50],     // R index
  [52, 42], [53, 52], [54, 53], [55, 54], [56, 55],     // R middle
  [57, 42], [58, 57], [59, 58], [60, 59], [61, 60],     // R ring
  [62, 42], [63, 62], [64, 63], [65, 64], [66, 65],     // R pinky
  // Left leg
  [67, 0], [68, 67], [69, 68], [70, 69], [71, 70],
  // Right leg
  [72, 0], [73, 72], [74, 73], [75, 74], [76, 75],
];

/**
 * SOMA 77-joint T-pose (rest pose) positions in world space [x, y, z] metres, Y-up.
 *
 * Extracted from kimodo/assets/skeletons/somaskel77/joints.p — no GPU or model needed.
 * Joint index matches SOMA_JOINT_NAMES order exactly.
 * This is the default "puppet" pose shown when the modal opens.
 */
export const SOMA_REST_POSE: [number, number, number][] = [
  [0.0, 0.0, 0.0],          // 0  Hips
  [-0.0001, 0.05, -0.0005], // 1  Spine1
  [-0.0001, 0.1213, -0.0008], // 2  Spine2
  [-0.0001, 0.1968, -0.009], // 3  Chest
  [-0.002, 0.4599, -0.0145], // 4  Neck1
  [-0.002, 0.537, 0.0085],  // 5  Neck2
  [-0.002, 0.5983, 0.028],  // 6  Head
  [-0.0019, 0.7589, 0.0097], // 7  HeadEnd
  [-0.0019, 0.603, 0.059],  // 8  Jaw
  [0.0301, 0.6521, 0.1039], // 9  LeftEye
  [-0.0342, 0.6519, 0.1036], // 10 RightEye
  [0.0161, 0.4292, 0.0421], // 11 LeftShoulder
  [0.1653, 0.4292, -0.0129], // 12 LeftArm
  [0.4527, 0.4292, -0.0129], // 13 LeftForeArm
  [0.7236, 0.4292, -0.0129], // 14 LeftHand
  [0.7464, 0.4152, 0.019],  // 15 LeftHandThumb1
  [0.7865, 0.397, 0.0354],  // 16 LeftHandThumb2
  [0.8145, 0.397, 0.0354],  // 17 LeftHandThumb3
  [0.8463, 0.397, 0.0354],  // 18 LeftHandThumbEnd
  [0.7561, 0.4238, 0.0101], // 19 LeftHandIndex1
  [0.8197, 0.424, 0.0119],  // 20 LeftHandIndex2
  [0.8564, 0.424, 0.0119],  // 21 LeftHandIndex3
  [0.8796, 0.424, 0.0119],  // 22 LeftHandIndex4
  [0.9072, 0.4222, 0.0107], // 23 LeftHandIndexEnd
  [0.7552, 0.4316, -0.0029], // 24 LeftHandMiddle1
  [0.8172, 0.429, -0.0129], // 25 LeftHandMiddle2
  [0.8607, 0.429, -0.0129], // 26 LeftHandMiddle3
  [0.8907, 0.429, -0.0129], // 27 LeftHandMiddle4
  [0.9137, 0.426, -0.0132], // 28 LeftHandMiddleEnd
  [0.7524, 0.4286, -0.0161], // 29 LeftHandRing1
  [0.811, 0.4238, -0.0298], // 30 LeftHandRing2
  [0.8545, 0.4238, -0.0298], // 31 LeftHandRing3
  [0.881, 0.4238, -0.0298], // 32 LeftHandRing4
  [0.9004, 0.4245, -0.0298], // 33 LeftHandRingEnd
  [0.7523, 0.4261, -0.0289], // 34 LeftHandPinky1
  [0.8031, 0.4128, -0.0466], // 35 LeftHandPinky2
  [0.8339, 0.4128, -0.0466], // 36 LeftHandPinky3
  [0.8494, 0.4128, -0.0466], // 37 LeftHandPinky4
  [0.8688, 0.4112, -0.046], // 38 LeftHandPinkyEnd
  [-0.0139, 0.4286, 0.0431], // 39 RightShoulder
  [-0.1643, 0.4286, -0.0123], // 40 RightArm
  [-0.4517, 0.4286, -0.0123], // 41 RightForeArm
  [-0.723, 0.4286, -0.0123], // 42 RightHand
  [-0.7458, 0.4148, 0.0193], // 43 RightHandThumb1
  [-0.7859, 0.3965, 0.0357], // 44 RightHandThumb2
  [-0.8138, 0.3965, 0.0357], // 45 RightHandThumb3
  [-0.8457, 0.3965, 0.0357], // 46 RightHandThumbEnd
  [-0.7555, 0.4234, 0.0105], // 47 RightHandIndex1
  [-0.819, 0.4235, 0.0123], // 48 RightHandIndex2
  [-0.8555, 0.4235, 0.0123], // 49 RightHandIndex3
  [-0.8788, 0.4235, 0.0123], // 50 RightHandIndex4
  [-0.9064, 0.4217, 0.0112], // 51 RightHandIndexEnd
  [-0.7547, 0.4311, -0.0023], // 52 RightHandMiddle1
  [-0.8165, 0.4285, -0.0123], // 53 RightHandMiddle2
  [-0.86, 0.4285, -0.0123], // 54 RightHandMiddle3
  [-0.89, 0.4285, -0.0123], // 55 RightHandMiddle4
  [-0.913, 0.4255, -0.0126], // 56 RightHandMiddleEnd
  [-0.7519, 0.4279, -0.0154], // 57 RightHandRing1
  [-0.8104, 0.4231, -0.0291], // 58 RightHandRing2
  [-0.8538, 0.4231, -0.0291], // 59 RightHandRing3
  [-0.8803, 0.4231, -0.0291], // 60 RightHandRing4
  [-0.8997, 0.4238, -0.0291], // 61 RightHandRingEnd
  [-0.7517, 0.4252, -0.0282], // 62 RightHandPinky1
  [-0.8026, 0.4118, -0.0459], // 63 RightHandPinky2
  [-0.8332, 0.4118, -0.0459], // 64 RightHandPinky3
  [-0.8487, 0.4118, -0.0459], // 65 RightHandPinky4
  [-0.8681, 0.4103, -0.0453], // 66 RightHandPinkyEnd
  [0.1004, -0.0843, 0.026],  // 67 LeftLeg
  [0.1004, -0.5166, 0.0179], // 68 LeftShin
  [0.1004, -0.9381, -0.0169], // 69 LeftFoot
  [0.1004, -0.9887, 0.1154], // 70 LeftToeBase
  [0.1003, -1.0052, 0.1806], // 71 LeftToeEnd
  [-0.1005, -0.083, 0.0262], // 72 RightLeg
  [-0.1005, -0.5166, 0.0181], // 73 RightShin
  [-0.1005, -0.9377, -0.0166], // 74 RightFoot
  [-0.1005, -0.9885, 0.1162], // 75 RightToeBase
  [-0.1004, -1.0049, 0.1808], // 76 RightToeEnd
];

/**
 * Parent index for each joint (by index).  Root (Hips=0) has parent -1.
 * Built from SOMA_BONES.  Used for FK propagation in the puppet editor:
 * moving a joint also moves all its descendants by the same delta.
 */
export const SOMA_PARENT: number[] = (() => {
  const parents = new Array<number>(77).fill(-1);
  for (const [child, parent] of SOMA_BONES) {
    parents[child] = parent;
  }
  return parents;
})();

/**
 * Simplified bone set for rendering — omits finger detail for cleaner display.
 * Uses the same joint indices as SOMA_BONES.
 */
export const SOMA_BONES_SIMPLIFIED: [number, number][] = [
  // Spine + neck + head
  [1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6],
  // Arms (to wrist only)
  [11, 3], [12, 11], [13, 12], [14, 13],
  [39, 3], [40, 39], [41, 40], [42, 41],
  // Legs
  [67, 0], [68, 67], [69, 68], [70, 69], [71, 70],
  [72, 0], [73, 72], [74, 73], [75, 74], [76, 75],
];

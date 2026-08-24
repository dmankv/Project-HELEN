"""Experimental standalone self-learning prototype for Daemon.

This module is not imported by the production web frontend. It provides a
standalone Python prototype of a learning pipeline for local experimentation.
"""

from typing import Dict, List, Tuple, Any, Optional
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
import json


class TaskOutcome(Enum):
    """Enumeration of possible task outcomes."""
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILURE = "failure"
    UNCLEAR = "unclear"


class FeedbackType(Enum):
    """Types of feedback that can be collected."""
    EXPLICIT = "explicit"  # Direct user rating
    IMPLICIT = "implicit"  # Inferred from user behavior
    CONTEXTUAL = "contextual"  # Inferred from conversation context


@dataclass
class Candidate:
    """Represents a candidate response or action."""
    id: str
    content: str
    reasoning: str
    confidence: float = 0.0
    reasoning_steps: List[str] = field(default_factory=list)


@dataclass
class Plan:
    """Represents a high-level plan for addressing user intent."""
    steps: List[str]
    reasoning: str
    intent: str
    estimated_complexity: str  # 'simple', 'moderate', 'complex'
    dependencies: List[str] = field(default_factory=list)


@dataclass
class LearningRecord:
    """Records a learning event for future improvement."""
    timestamp: datetime
    input: str
    intent: str
    plan: Dict[str, Any]
    response: str
    feedback: Optional[str] = None
    feedback_type: Optional[FeedbackType] = None
    outcome: Optional[TaskOutcome] = None
    score: float = 0.0
    success_metrics: Dict[str, float] = field(default_factory=dict)


class Policy:
    """Stores and updates decision-making policies based on learning."""
    
    def __init__(self):
        self.min_confidence_threshold: float = 0.6
        self.intent_scores: Dict[str, float] = {}
        self.plan_effectiveness: Dict[str, float] = {}
        self.response_quality: Dict[str, float] = {}
        self.learning_history: List[LearningRecord] = []
        self.policy_version: int = 1
    
    def update(
        self,
        intent: str,
        plan: str,
        score: float,
        feedback: Optional[str] = None,
        outcome: Optional[TaskOutcome] = None
    ) -> None:
        """Update policy based on interaction outcome."""
        # Update intent effectiveness
        if intent not in self.intent_scores:
            self.intent_scores[intent] = 0.0
        self.intent_scores[intent] = (
            0.8 * self.intent_scores[intent] + 0.2 * score
        )
        
        # Update plan effectiveness
        if plan not in self.plan_effectiveness:
            self.plan_effectiveness[plan] = 0.0
        effectiveness = 1.0 if outcome == TaskOutcome.SUCCESS else 0.0
        self.plan_effectiveness[plan] = (
            0.8 * self.plan_effectiveness[plan] + 0.2 * effectiveness
        )
        
        # Adjust confidence threshold based on feedback quality
        if outcome == TaskOutcome.FAILURE and score > self.min_confidence_threshold:
            self.min_confidence_threshold = min(0.9, self.min_confidence_threshold + 0.05)
        elif outcome == TaskOutcome.SUCCESS and score < self.min_confidence_threshold:
            self.min_confidence_threshold = max(0.5, self.min_confidence_threshold - 0.05)
        
        self.policy_version += 1
    
    def get_intent_weight(self, intent: str) -> float:
        """Get learned weight for an intent."""
        return self.intent_scores.get(intent, 0.5)
    
    def get_plan_effectiveness(self, plan: str) -> float:
        """Get historical effectiveness of a plan."""
        return self.plan_effectiveness.get(plan, 0.5)


class MemoryStore:
    """Stores and retrieves interaction memory for learning."""
    
    def __init__(self):
        self.records: List[LearningRecord] = []
        self.indexed_by_intent: Dict[str, List[LearningRecord]] = {}
        self.indexed_by_keyword: Dict[str, List[LearningRecord]] = {}
    
    def save(self, record: LearningRecord) -> None:
        """Save a learning record to memory."""
        self.records.append(record)
        
        # Index by intent
        if record.intent not in self.indexed_by_intent:
            self.indexed_by_intent[record.intent] = []
        self.indexed_by_intent[record.intent].append(record)
        
        # Index by keywords
        keywords = self._extract_keywords(record.input)
        for keyword in keywords:
            if keyword not in self.indexed_by_keyword:
                self.indexed_by_keyword[keyword] = []
            self.indexed_by_keyword[keyword].append(record)
    
    def retrieve(
        self,
        user_input: str,
        top_k: int = 5,
        by_intent: Optional[str] = None
    ) -> List[LearningRecord]:
        """Retrieve relevant memories based on input or intent."""
        if by_intent and by_intent in self.indexed_by_intent:
            return self.indexed_by_intent[by_intent][-top_k:]
        
        # Retrieve by keyword similarity
        keywords = self._extract_keywords(user_input)
        relevance_scores: Dict[int, float] = {}
        records_by_id: Dict[int, LearningRecord] = {}
        
        for keyword in keywords:
            for record in self.indexed_by_keyword.get(keyword, []):
                record_id = id(record)
                records_by_id[record_id] = record
                relevance_scores[record_id] = relevance_scores.get(record_id, 0.0) + 1.0
        
        # Sort by relevance score
        sorted_record_ids = sorted(
            relevance_scores.items(),
            key=lambda x: x[1],
            reverse=True
        )
        return [records_by_id[record_id] for record_id, _ in sorted_record_ids[:top_k]]
    
    def _extract_keywords(self, text: str) -> List[str]:
        """Extract keywords from text for indexing."""
        stopwords = {'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were'}
        words = text.lower().split()
        return [w for w in words if w not in stopwords and len(w) > 3]
    
    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about stored memory."""
        successful = sum(1 for r in self.records if r.outcome == TaskOutcome.SUCCESS)
        return {
            "total_records": len(self.records),
            "successful_interactions": successful,
            "success_rate": successful / len(self.records) if self.records else 0,
            "intents_tracked": len(self.indexed_by_intent),
            "keywords_tracked": len(self.indexed_by_keyword)
        }


class SelfLearningAgent:
    """Core self-learning AI agent implementing Daemon's intelligence."""
    
    def __init__(self):
        self.memory_store = MemoryStore()
        self.policy = Policy()
        self.session_state: Dict[str, Any] = {}
        self.interaction_count: int = 0
    
    def process(self, user_input: str) -> Tuple[str, Dict[str, Any]]:
        """
        Process user input through the complete learning pipeline.
        Returns the response and metadata about the decision process.
        """
        self.interaction_count += 1
        
        # Step 1: Understand the request
        intent = self._classify_intent(user_input)
        ambiguity = self._estimate_ambiguity(user_input)
        
        # Step 2: Retrieve relevant memory
        relevant_memory = self.memory_store.retrieve(user_input, top_k=5)
        
        # Step 3: Plan next action
        if ambiguity > 0.8:
            response = self._ask_clarifying_question(user_input)
            return response, {"type": "clarification_needed", "ambiguity": ambiguity}
        
        plan = self._create_plan(intent, user_input, relevant_memory)
        
        # Step 4: Generate candidates
        candidates = self._generate_candidates(user_input, plan, relevant_memory)
        
        # Step 5: Evaluate candidates
        scored_candidates = []
        for candidate in candidates:
            score = self._evaluate_candidate(
                candidate=candidate,
                user_input=user_input,
                memory=relevant_memory,
                plan=plan
            )
            scored_candidates.append((candidate, score))
        
        # Step 6: Choose best candidate
        if not scored_candidates:
            response = "I apologize, but I need more context to provide a proper response."
            best_score = 0.0
        else:
            best_candidate, best_score = max(scored_candidates, key=lambda x: x[1])
            
            if best_score < self.policy.min_confidence_threshold:
                response = self._ask_clarifying_question(user_input)
            else:
                response = best_candidate.content
        
        # Step 7: Produce response
        # (Already done above)
        
        # Step 8: Learn from interaction (asynchronous)
        # This would be called with feedback later
        self._queue_learning({
            "input": user_input,
            "intent": intent,
            "plan": plan,
            "response": response,
            "score": best_score
        })
        
        return response, {
            "type": "response",
            "intent": intent,
            "confidence": best_score,
            "ambiguity": ambiguity,
            "memory_used": len(relevant_memory)
        }
    
    def learn_from_feedback(
        self,
        interaction_id: str,
        feedback: str,
        feedback_type: FeedbackType = FeedbackType.EXPLICIT,
        outcome: Optional[TaskOutcome] = None
    ) -> None:
        """Learn from user feedback on a previous response."""
        # This would look up the queued interaction and process feedback
        # Implementation depends on how interactions are tracked
        pass
    
    def _classify_intent(self, user_input: str) -> str:
        """Classify the user's intent from their input."""
        keywords_to_intent = {
            'help': 'request_assistance',
            'how': 'request_explanation',
            'what': 'request_information',
            'why': 'request_reasoning',
            'create': 'request_creation',
            'generate': 'request_creation',
            'summarize': 'request_summary',
            'remember': 'memory_access',
        }
        
        user_input_lower = user_input.lower()
        for keyword, intent in keywords_to_intent.items():
            if keyword in user_input_lower:
                return intent
        
        return 'general_inquiry'
    
    def _estimate_ambiguity(self, user_input: str) -> float:
        """
        Estimate how ambiguous or unclear the user's request is.
        Returns a score between 0.0 (clear) and 1.0 (very ambiguous).
        """
        ambiguity = 0.0
        
        # Short inputs are often ambiguous
        if len(user_input) < 10:
            ambiguity += 0.3
        
        # Multiple questions indicate complexity
        question_count = user_input.count('?')
        if question_count > 2:
            ambiguity += 0.2
        
        # Vague keywords indicate ambiguity
        vague_words = ['thing', 'stuff', 'something', 'somehow', 'maybe', 'perhaps']
        vague_count = sum(1 for word in vague_words if word in user_input.lower())
        ambiguity += vague_count * 0.1
        
        return min(1.0, ambiguity)
    
    def _ask_clarifying_question(self, user_input: str) -> str:
        """Generate a clarifying question when request is ambiguous."""
        return f"I want to help you better. Could you provide more details about: {user_input[:30]}...?"
    
    def _create_plan(
        self,
        intent: str,
        user_input: str,
        relevant_memory: List[LearningRecord]
    ) -> Plan:
        """Create a plan for handling the user's request."""
        steps = []
        reasoning = ""
        complexity = "simple"
        
        if intent == 'request_creation':
            steps = [
                "Understand requirements",
                "Break down into components",
                "Generate structured response"
            ]
            complexity = "complex"
            reasoning = "Complex creation task requires detailed breakdown"
        elif intent == 'request_explanation':
            steps = [
                "Identify key concepts",
                "Structure explanation logically",
                "Provide examples"
            ]
            complexity = "moderate"
            reasoning = "Explanation requires logical structure and examples"
        elif intent == 'request_information':
            steps = [
                "Retrieve relevant information",
                "Verify accuracy",
                "Present clearly"
            ]
            complexity = "simple"
            reasoning = "Information retrieval is straightforward"
        elif intent == 'memory_access':
            steps = ["Search memory", "Retrieve relevant interactions", "Synthesize response"]
            complexity = "moderate" if relevant_memory else "simple"
            reasoning = f"Using {len(relevant_memory)} relevant memories"
        else:
            steps = ["Process input", "Generate response"]
            complexity = "simple"
            reasoning = "General inquiry"
        
        return Plan(
            steps=steps,
            reasoning=reasoning,
            intent=intent,
            estimated_complexity=complexity
        )
    
    def _generate_candidates(
        self,
        user_input: str,
        plan: Plan,
        relevant_memory: List[LearningRecord]
    ) -> List[Candidate]:
        """Generate candidate responses."""
        candidates = []
        
        # Candidate 1: Direct response
        candidates.append(Candidate(
            id="direct_response",
            content=f"Based on your question '{user_input[:40]}...', here's my response...",
            reasoning="Direct, straightforward answer",
            confidence=0.75
        ))
        
        # Candidate 2: Memory-informed response
        if relevant_memory:
            candidates.append(Candidate(
                id="memory_informed",
                content="Based on our previous interactions, I can provide a more informed response...",
                reasoning="Leveraging relevant historical context",
                confidence=0.85
            ))
        
        # Candidate 3: Structured breakdown
        if plan.estimated_complexity in ["moderate", "complex"]:
            candidates.append(Candidate(
                id="structured_breakdown",
                content="Let me break this down into manageable steps...",
                reasoning="Breaking down complex request into steps",
                confidence=0.80
            ))
        
        return candidates
    
    def _evaluate_candidate(
        self,
        candidate: Candidate,
        user_input: str,
        memory: List[LearningRecord],
        plan: Plan
    ) -> float:
        """
        Evaluate a candidate response and return a confidence score.
        """
        score = candidate.confidence
        
        # Boost score if plan effectiveness is high
        plan_str = json.dumps(plan.__dict__, default=str)
        plan_effectiveness = self.policy.get_plan_effectiveness(plan_str)
        score = score * 0.7 + plan_effectiveness * 0.3
        
        # Boost score if using relevant memory
        if memory and candidate.id == "memory_informed":
            score += 0.1 * min(len(memory) / 5, 1.0)
        
        # Penalize if ambiguity is high
        ambiguity = self._estimate_ambiguity(user_input)
        score *= (1.0 - ambiguity * 0.2)
        
        return min(1.0, score)
    
    def _queue_learning(self, interaction_data: Dict[str, Any]) -> None:
        """Queue an interaction for later learning with feedback."""
        # This stores the interaction for later processing with feedback
        self.session_state['last_interaction'] = {
            **interaction_data,
            'timestamp': datetime.now()
        }
    
    def get_agent_stats(self) -> Dict[str, Any]:
        """Get statistics about agent performance and learning."""
        memory_stats = self.memory_store.get_stats()
        return {
            "interaction_count": self.interaction_count,
            "policy_version": self.policy.policy_version,
            "confidence_threshold": self.policy.min_confidence_threshold,
            "memory": memory_stats,
            "learned_intents": len(self.policy.intent_scores),
            "learned_plans": len(self.policy.plan_effectiveness)
        }


# Example standalone demo
if __name__ == "__main__":
    agent = SelfLearningAgent()
    
    # Test interactions
    test_inputs = [
        "How do I create a web application?",
        "What is machine learning?",
        "Help me understand neural networks",
        "Remember our conversation about AI?"
    ]
    
    for user_input in test_inputs:
        response, metadata = agent.process(user_input)
        print(f"\nInput: {user_input}")
        print(f"Response: {response}")
        print(f"Metadata: {metadata}")
    
    # Print agent statistics
    print(f"\nAgent Statistics: {agent.get_agent_stats()}")

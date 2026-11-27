package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.softline.support.chat.FaqStore.FaqApproval;
import ru.softline.support.chat.FaqStore.FaqView;

@RestController
@RequestMapping("/api/v1/manager/handoffs")
class ManagerController {
    private final ManagerAccess access;
    private final ManagerStore store;

    ManagerController(ManagerAccess access, ManagerStore store) {
        this.access = access;
        this.store = store;
    }

    @ModelAttribute
    void authorize(HttpServletRequest request, HttpServletResponse response) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        request.setAttribute("manager", access.requireManager(request.getHeader(HttpHeaders.AUTHORIZATION)));
    }

    @GetMapping
    List<QueueItem> list(@RequestAttribute("manager") String manager, @RequestParam(defaultValue = "50") int limit,
                        @RequestParam(defaultValue = "0") int offset) {
        if (limit < 1 || limit > 100 || offset < 0) throw ChatErrors.invalid();
        return store.list(manager, limit, offset);
    }

    @GetMapping("/{id}")
    AssignedHandoff read(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.read(id, manager);
    }

    @PostMapping("/{id}/claim")
    QueueItem claim(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.claim(id, manager);
    }

    @PostMapping("/{id}/messages")
    Message reply(@PathVariable UUID id, @RequestAttribute("manager") String manager, @RequestBody ManagerMessage input) {
        if (input.messageId() == null || input.text() == null || input.text().isBlank() || input.text().length() > 4_000) {
            throw ChatErrors.invalid();
        }
        return store.reply(id, manager, input);
    }

    @PostMapping("/{id}/resolve")
    QueueItem resolve(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.resolve(id, manager);
    }

    @GetMapping("/{id}/faq")
    FaqView readFaq(@PathVariable UUID id, @RequestAttribute("manager") String manager,
                    @RequestParam(name = "source_query", required = false) String query) {
        if (query != null && !validFaqText(query, 200)) throw ChatErrors.invalid();
        return store.readFaq(id, manager, query);
    }

    @PostMapping("/{id}/faq/approve")
    FaqView approveFaq(@PathVariable UUID id, @RequestAttribute("manager") String manager,
                       @RequestBody FaqApproval input) {
        if (input.sourceId() == null || !validFaqText(input.question(), 500) || !validFaqText(input.answer(), 2000)
                || input.product() != null && !validFaqText(input.product(), 120)
                || input.edition() != null && (input.product() == null || !validFaqText(input.edition(), 120))) {
            throw ChatErrors.invalid();
        }
        String question = input.question().strip();
        String answer = input.answer().strip();
        String key = FaqText.key(question);
        String product = input.product() == null ? null : input.product().strip();
        String edition = input.edition() == null ? null : input.edition().strip();
        if ((product != null && !FaqText.contains(key, FaqText.key(product)))
                || (edition != null && !FaqText.contains(key, FaqText.key(edition)))
                || FaqText.caseSpecific(question) || FaqText.caseSpecific(answer)
                || FaqText.dynamic(question) || FaqText.dynamic(answer)) {
            throw new ChatError(400, "FAQ_NOT_GENERAL", "Для FAQ нужен общий справочный ответ без данных заказа.");
        }
        return store.approveFaq(id, manager, new FaqApproval(question, answer, input.sourceId(), product, edition));
    }

    @PostMapping("/{id}/faq/reject")
    FaqView rejectFaq(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.rejectFaq(id, manager);
    }

    @PostMapping("/{id}/faq/unpublish")
    FaqView unpublishFaq(@PathVariable UUID id, @RequestAttribute("manager") String manager) {
        return store.unpublishFaq(id, manager);
    }

    private static boolean validFaqText(String text, int length) {
        return text != null && text.length() <= length && !FaqText.key(text).isEmpty() && !FaqText.privateData(text);
    }
}
